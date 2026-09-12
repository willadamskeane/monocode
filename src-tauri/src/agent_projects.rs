use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, validate_id, SessionStore};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_PAYLOAD: usize = 256_000;
const CHANGED: &str = "agent-projects-changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectDocument {
    id: String,
    name: String,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentProjectRole {
    Coordinator,
    Worker,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectMember {
    session_id: String,
    role: AgentProjectRole,
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectSubscription {
    id: String,
    name: String,
    prompt: String,
    interval_minutes: i64,
    enabled: bool,
    next_run_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProject {
    id: String,
    cwd: String,
    name: String,
    goal: String,
    instructions: String,
    documents: Vec<AgentProjectDocument>,
    members: Vec<AgentProjectMember>,
    subscriptions: Vec<AgentProjectSubscription>,
    archived: bool,
    #[serde(default)]
    legacy_default: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedSubscription {
    project: AgentProject,
    subscription: AgentProjectSubscription,
}

pub fn ensure_agent_projects_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_projects (
           id TEXT PRIMARY KEY,
           cwd TEXT NOT NULL,
           data_json TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS agent_projects_cwd ON agent_projects(cwd);
         CREATE TABLE IF NOT EXISTS agent_project_defaults (
           cwd TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           retained_project_id TEXT
         );
         CREATE TABLE IF NOT EXISTS agent_project_members (
           session_id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL REFERENCES agent_projects(id) ON DELETE CASCADE,
           role TEXT NOT NULL CHECK(role IN ('coordinator', 'worker')),
           title TEXT NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS agent_project_coordinator
           ON agent_project_members(project_id) WHERE role = 'coordinator';
         CREATE TRIGGER IF NOT EXISTS agent_projects_session_deleted
         BEFORE DELETE ON sessions BEGIN
           UPDATE agent_projects SET updated_at = MAX(updated_at + 1,
             CAST(strftime('%s', 'now') AS INTEGER) * 1000)
             WHERE id IN (SELECT project_id FROM agent_project_members WHERE session_id = OLD.id);
           DELETE FROM agent_project_members WHERE session_id = OLD.id;
         END;",
    )
}

fn bounded(value: &str, label: &str, max: usize, required: bool) -> Result<(), String> {
    if value.len() > max || value.contains('\0') || (required && value.trim().is_empty()) {
        return Err(format!("Invalid {label}: maximum {max} UTF-8 bytes"));
    }
    Ok(())
}

fn id(value: &str) -> Result<(), String> {
    bounded(value, "project identifier", 128, true)?;
    validate_id(value, "project")
}

// Lexical identity only: project metadata never reads the repository or resolves symlinks.
pub(crate) fn normalize_cwd(value: &str) -> Result<String, String> {
    bounded(value, "repository path", 4096, true)?;
    if value.chars().any(char::is_control) {
        return Err("Invalid repository path".into());
    }
    let windows =
        value.as_bytes().get(1) == Some(&b':') && value.as_bytes()[0].is_ascii_alphabetic();
    let unc = value.starts_with("//") || value.starts_with("\\\\");
    let path = if windows || unc {
        value.replace('\\', "/").to_lowercase()
    } else {
        value.to_string()
    };
    let (prefix, rest, floor) =
        if windows && (path.len() == 2 || path.as_bytes().get(2) == Some(&b'/')) {
            (format!("{}/", &path[..2]), path.get(3..).unwrap_or(""), 0)
        } else if unc {
            ("//".into(), path.trim_start_matches('/'), 2)
        } else if path.starts_with('/') {
            ("/".into(), path.trim_start_matches('/'), 0)
        } else {
            return Err("Repository path must be absolute".into());
        };
    let mut parts = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.len() <= floor {
                    return Err("Repository path escapes its root".into());
                }
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    if unc && parts.len() < 2 {
        return Err("UNC repository path requires a server and share".into());
    }
    let normalized = format!("{prefix}{}", parts.join("/"));
    bounded(&normalized, "repository path", 4096, true)?;
    Ok(normalized)
}

fn timestamp(value: i64) -> Result<(), String> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err("Invalid project timestamp".into());
    }
    Ok(())
}

fn validate(project: &mut AgentProject) -> Result<(), String> {
    project.cwd = normalize_cwd(&project.cwd)?;
    // Reserve timestamp growth so later native revisions/claims always fit.
    let mut budget = project.clone();
    budget.created_at = MAX_SAFE_INTEGER;
    budget.updated_at = MAX_SAFE_INTEGER;
    for subscription in &mut budget.subscriptions {
        subscription.next_run_at = MAX_SAFE_INTEGER;
    }
    let json = serde_json::to_string(&budget).map_err(|e| e.to_string())?;
    if json.len() > MAX_PAYLOAD {
        return Err("Project exceeds 256000 UTF-8 bytes".into());
    }
    id(&project.id)?;
    bounded(&project.name, "project name", 200, true)?;
    bounded(&project.goal, "project goal", 16_000, false)?;
    bounded(&project.instructions, "project instructions", 16_000, false)?;
    timestamp(project.created_at)?;
    timestamp(project.updated_at)?;
    if project.documents.len() > 20
        || project.members.len() > 64
        || project.subscriptions.len() > 20
    {
        return Err(
            "Project supports at most 20 documents, 64 members and 20 subscriptions".into(),
        );
    }
    let mut ids = HashSet::new();
    for document in &project.documents {
        id(&document.id)?;
        if !ids.insert(&document.id) {
            return Err("Duplicate document id".into());
        }
        bounded(&document.name, "document name", 200, true)?;
        bounded(&document.content, "document content", 32_000, false)?;
    }
    ids.clear();
    let mut coordinators = 0;
    for member in &project.members {
        id(&member.session_id)?;
        bounded(&member.title, "member title", 200, true)?;
        if !ids.insert(&member.session_id) {
            return Err("Duplicate project member".into());
        }
        if member.role == AgentProjectRole::Coordinator {
            coordinators += 1;
        }
    }
    if coordinators > 1 {
        return Err("A project can have only one coordinator".into());
    }
    ids.clear();
    for subscription in &project.subscriptions {
        id(&subscription.id)?;
        if !ids.insert(&subscription.id) {
            return Err("Duplicate subscription id".into());
        }
        bounded(&subscription.name, "subscription name", 200, true)?;
        bounded(&subscription.prompt, "subscription prompt", 16_000, true)?;
        if !(15..=10_080).contains(&subscription.interval_minutes) {
            return Err("Subscription interval must be 15–10080 minutes".into());
        }
        timestamp(subscription.next_run_at)?;
    }
    Ok(())
}

fn list_projects(conn: &Connection, cwd: Option<&str>) -> Result<Vec<AgentProject>, String> {
    let cwd = cwd.map(normalize_cwd).transpose()?;
    let mut stmt = conn
        .prepare(
            "SELECT data_json, created_at, updated_at FROM agent_projects
                  WHERE (?1 IS NULL OR cwd = ?1) ORDER BY updated_at DESC, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![cwd], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut projects = Vec::new();
    for row in rows {
        let (json, created_at, updated_at) = row.map_err(|e| e.to_string())?;
        let mut project: AgentProject = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        project.created_at = created_at;
        project.updated_at = updated_at;
        project.legacy_default = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_project_defaults WHERE project_id = ?1)",
                params![project.id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut members = conn
            .prepare("SELECT session_id, role, title FROM agent_project_members WHERE project_id = ?1 ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        project.members = members
            .query_map(params![project.id], |row| {
                Ok(AgentProjectMember {
                    session_id: row.get(0)?,
                    role: if row.get::<_, String>(1)? == "coordinator" {
                        AgentProjectRole::Coordinator
                    } else {
                        AgentProjectRole::Worker
                    },
                    title: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        projects.push(project);
    }
    Ok(projects)
}

fn next_revision(previous: i64) -> Result<i64, String> {
    let next = now_millis().max(previous + 1);
    timestamp(next)?;
    Ok(next)
}

fn write_project(conn: &Connection, project: &AgentProject) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_projects(id, cwd, data_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at",
        params![project.id, project.cwd, serde_json::to_string(project).map_err(|e| e.to_string())?,
            project.created_at, project.updated_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn save_project(conn: &mut Connection, mut project: AgentProject) -> Result<AgentProject, String> {
    validate(&mut project)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let existing: Option<(String, i64, i64)> = tx
        .query_row(
            "SELECT cwd, created_at, updated_at FROM agent_projects WHERE id = ?1",
            params![project.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((cwd, created_at, updated_at)) = existing {
        if updated_at != project.updated_at {
            return Err(
                "Project changed in another window or scheduled run; reload before saving".into(),
            );
        }
        if cwd != project.cwd {
            return Err("A project's repository cannot be changed".into());
        }
        project.created_at = created_at;
    } else {
        if project.updated_at != 0 || project.created_at != 0 {
            return Err("Project no longer exists; reload before saving".into());
        }
        project.created_at = now_millis();
    }
    project.updated_at = next_revision(project.updated_at)?;
    project.legacy_default = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_project_defaults WHERE project_id = ?1)",
            params![project.id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    write_project(&tx, &project)?;
    tx.execute(
        "DELETE FROM agent_project_members WHERE project_id = ?1",
        params![project.id],
    )
    .map_err(|e| e.to_string())?;
    for member in &project.members {
        let stored: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT cwd, project_id FROM sessions WHERE id = ?1",
                params![member.session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((cwd, owner)) = stored {
            if normalize_cwd(&cwd)? != project.cwd {
                return Err("Session repository does not match project".into());
            }
            if owner.as_deref().is_some_and(|owner| owner != project.id) {
                return Err(
                    "Session already belongs to another project; explicitly move it first".into(),
                );
            }
            tx.execute(
                "UPDATE sessions SET project_id = ?1 WHERE id = ?2",
                params![project.id, member.session_id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO agent_project_members(session_id, project_id, role, title) VALUES (?1, ?2, ?3, ?4)",
            params![member.session_id, project.id,
                if member.role == AgentProjectRole::Coordinator { "coordinator" } else { "worker" }, member.title],
        ).map_err(|_| "Session already belongs to another project; reload before saving".to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(project)
}

fn delete_project(conn: &Connection, project_id: &str, disposition: &str) -> Result<(), String> {
    id(project_id)?;
    if !matches!(disposition, "keep" | "delete") {
        return Err("Invalid chat disposition".into());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let cwd: Option<String> = tx
        .query_row(
            "SELECT cwd FROM agent_projects WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(cwd) = cwd else { return Ok(()) };
    if disposition == "delete" {
        tx.execute(
            "DELETE FROM sessions WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let owned: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE project_id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if owned > 0 {
            let target = default_destination(&tx, &cwd, project_id)?;
            tx.execute(
                "UPDATE sessions SET project_id = ?1 WHERE project_id = ?2",
                params![target.id, project_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "DELETE FROM agent_projects WHERE id = ?1",
        params![project_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProject {
    cwd: String,
    name: String,
    #[serde(default)]
    archived: bool,
}

fn create_default(
    conn: &Connection,
    cwd: &str,
    name: Option<&str>,
    archived: bool,
) -> Result<AgentProject, String> {
    let id: String = conn
        .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut project = AgentProject {
        id,
        cwd: cwd.into(),
        name: name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| {
                cwd.rsplit('/')
                    .find(|part| !part.is_empty())
                    .unwrap_or("Project")
            })
            .chars()
            .take(50)
            .collect(),
        goal: String::new(),
        instructions: String::new(),
        documents: vec![],
        members: vec![],
        subscriptions: vec![],
        archived,
        legacy_default: false,
        created_at: now_millis(),
        updated_at: now_millis(),
    };
    validate(&mut project)?;
    write_project(conn, &project)?;
    Ok(project)
}

fn ensure_default(
    conn: &Connection,
    cwd: &str,
    name: Option<&str>,
    archived: bool,
) -> Result<AgentProject, String> {
    let cwd = normalize_cwd(cwd)?;
    let mapped: Option<String> = conn
        .query_row(
            "SELECT project_id FROM agent_project_defaults WHERE cwd = ?1",
            params![cwd],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(project) = list_projects(conn, Some(&cwd))?
        .into_iter()
        .find(|project| Some(&project.id) == mapped.as_ref())
    {
        return Ok(project);
    }
    let mut project = create_default(conn, &cwd, name, archived)?;
    conn.execute(
        "INSERT INTO agent_project_defaults(cwd, project_id) VALUES (?1, ?2)
         ON CONFLICT(cwd) DO UPDATE SET project_id = excluded.project_id",
        params![cwd, project.id],
    )
    .map_err(|e| e.to_string())?;
    project.legacy_default = true;
    Ok(project)
}

fn default_destination(
    conn: &Connection,
    cwd: &str,
    deleting: &str,
) -> Result<AgentProject, String> {
    let mapped: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT project_id, retained_project_id FROM agent_project_defaults WHERE cwd = ?1",
            params![cwd],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((default_id, retained_id)) = mapped {
        if default_id == deleting {
            if let Some(project) = list_projects(conn, Some(cwd))?
                .into_iter()
                .find(|project| Some(&project.id) == retained_id.as_ref() && project.id != deleting)
            {
                return Ok(project);
            }
            let project = create_default(conn, cwd, Some("Retained chats"), false)?;
            conn.execute(
                "UPDATE agent_project_defaults SET retained_project_id = ?1 WHERE cwd = ?2",
                params![project.id, cwd],
            )
            .map_err(|e| e.to_string())?;
            return Ok(project);
        }
    }
    ensure_default(conn, cwd, None, false)
}

fn migrate_legacy(
    conn: &mut Connection,
    legacy: Vec<LegacyProject>,
) -> Result<Vec<AgentProject>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut candidates = std::collections::BTreeMap::new();
    for item in legacy {
        if let Ok(cwd) = normalize_cwd(&item.cwd) {
            candidates.entry(cwd).or_insert((item.name, item.archived));
        }
    }
    let stored = tx
        .prepare("SELECT DISTINCT cwd FROM sessions")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for cwd in stored {
        if let Ok(cwd) = normalize_cwd(&cwd) {
            candidates.entry(cwd).or_insert((String::new(), false));
        }
    }
    // Explicit specialized memberships predate ordinary-chat ownership.
    sync_member_ownership(&tx)?;
    for (cwd, (name, archived)) in candidates {
        let mapped: Option<String> = tx
            .query_row(
                "SELECT project_id FROM agent_project_defaults WHERE cwd = ?1",
                params![cwd],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let project_id = match mapped {
            Some(id) => id,
            None => ensure_default(&tx, &cwd, Some(&name), archived)?.id,
        };
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_projects WHERE id = ?1)",
                params![project_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        // A dangling mapping is a durable deletion marker, not an invitation to recreate.
        if !exists {
            continue;
        }
        let unassigned = tx
            .prepare("SELECT id, cwd FROM sessions WHERE project_id IS NULL")
            .map_err(|e| e.to_string())?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        for (session_id, session_cwd) in unassigned {
            if normalize_cwd(&session_cwd).ok().as_deref() == Some(&cwd) {
                tx.execute(
                    "UPDATE sessions SET project_id = ?1 WHERE id = ?2 AND project_id IS NULL",
                    params![project_id, session_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    let projects = list_projects(&tx, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(projects)
}

pub(crate) fn sync_member_ownership(conn: &Connection) -> Result<(), String> {
    let rows = conn
        .prepare(
            "SELECT s.id, s.cwd, p.cwd, p.id FROM sessions s
         JOIN agent_project_members m ON m.session_id = s.id
         JOIN agent_projects p ON p.id = m.project_id WHERE s.project_id IS NULL",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for (session_id, cwd, project_cwd, project_id) in rows {
        if normalize_cwd(&cwd).ok() == normalize_cwd(&project_cwd).ok() {
            conn.execute(
                "UPDATE sessions SET project_id = ?1 WHERE id = ?2 AND project_id IS NULL",
                params![project_id, session_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn delete_projects_for_cwd(conn: &Connection, cwd: &str) -> Result<(), String> {
    let cwd = normalize_cwd(cwd)?;
    conn.execute("DELETE FROM agent_projects WHERE cwd = ?1", params![cwd])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn claim_due(conn: &mut Connection, now: i64) -> Result<Vec<ClaimedSubscription>, String> {
    if !(0..=MAX_SAFE_INTEGER - 604_800_000).contains(&now) {
        return Err("Invalid subscription claim timestamp".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut claimed = Vec::new();
    for mut project in list_projects(&tx, None)? {
        if project.archived {
            continue;
        }
        let mut due = Vec::new();
        for subscription in &mut project.subscriptions {
            if subscription.enabled && subscription.next_run_at <= now {
                subscription.next_run_at = now + subscription.interval_minutes * 60_000;
                due.push(subscription.clone());
            }
        }
        if !due.is_empty() {
            project.updated_at = next_revision(project.updated_at)?;
            write_project(&tx, &project)?;
            for subscription in due {
                claimed.push(ClaimedSubscription {
                    project: project.clone(),
                    subscription,
                });
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(claimed)
}

#[tauri::command(async)]
pub fn agent_projects_list(
    store: State<'_, SessionStore>,
    cwd: Option<String>,
) -> Result<Vec<AgentProject>, String> {
    list_projects(&*store.lock_conn()?, cwd.as_deref())
}

#[tauri::command(async)]
pub fn agent_projects_save(
    app: AppHandle,
    store: State<'_, SessionStore>,
    project: AgentProject,
) -> Result<AgentProject, String> {
    let saved = save_project(&mut *store.lock_conn()?, project)?;
    let _ = app.emit(CHANGED, ());
    Ok(saved)
}

#[tauri::command(async)]
pub fn agent_projects_delete(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    disposition: Option<String>,
) -> Result<(), String> {
    delete_project(
        &*store.lock_conn()?,
        &id,
        disposition.as_deref().unwrap_or("keep"),
    )?;
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command(async)]
pub fn agent_projects_migrate_legacy(
    app: AppHandle,
    store: State<'_, SessionStore>,
    legacy: Vec<LegacyProject>,
) -> Result<Vec<AgentProject>, String> {
    let projects = migrate_legacy(&mut *store.lock_conn()?, legacy)?;
    let _ = app.emit(CHANGED, ());
    Ok(projects)
}

#[tauri::command(async)]
pub fn agent_projects_ensure_default(
    app: AppHandle,
    store: State<'_, SessionStore>,
    cwd: String,
    name: Option<String>,
) -> Result<AgentProject, String> {
    let mut conn = store.lock_conn()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let project = ensure_default(&tx, &cwd, name.as_deref(), false)?;
    tx.commit().map_err(|e| e.to_string())?;
    let _ = app.emit(CHANGED, ());
    Ok(project)
}

#[tauri::command(async)]
pub fn agent_projects_delete_for_cwd(
    app: AppHandle,
    store: State<'_, SessionStore>,
    cwd: String,
) -> Result<(), String> {
    delete_projects_for_cwd(&*store.lock_conn()?, &cwd)?;
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command(async)]
pub fn agent_projects_claim_due(
    app: AppHandle,
    store: State<'_, SessionStore>,
    now: i64,
) -> Result<Vec<ClaimedSubscription>, String> {
    let claimed = claim_due(&mut *store.lock_conn()?, now)?;
    if !claimed.is_empty() {
        let _ = app.emit(CHANGED, ());
    }
    Ok(claimed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn project(id: &str, cwd: &str) -> AgentProject {
        AgentProject {
            id: id.into(),
            cwd: cwd.into(),
            name: "Project".into(),
            goal: "Ship the feature".into(),
            instructions: "Run relevant tests".into(),
            documents: vec![AgentProjectDocument {
                id: "doc".into(),
                name: "Design".into(),
                content: "Reference data".into(),
            }],
            members: vec![],
            subscriptions: vec![],
            archived: false,
            legacy_default: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn member(session_id: &str, role: AgentProjectRole) -> AgentProjectMember {
        AgentProjectMember {
            session_id: session_id.into(),
            role,
            title: "Task".into(),
        }
    }

    fn subscription(id: &str, enabled: bool) -> AgentProjectSubscription {
        AgentProjectSubscription {
            id: id.into(),
            name: "Review".into(),
            prompt: "Review changes".into(),
            interval_minutes: 15,
            enabled,
            next_run_at: 100,
        }
    }

    #[test]
    fn crud_and_repository_isolation() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        ensure_agent_projects_table(&conn).unwrap();
        let mut saved = save_project(&mut conn, project("one", "/repo/a/./")).unwrap();
        save_project(&mut conn, project("two", "/repo/b")).unwrap();
        assert_eq!(saved.cwd, "/repo/a");
        assert!(saved.created_at > 0);
        assert!(saved.updated_at > 0);
        assert_eq!(list_projects(&conn, Some("/repo/a")).unwrap().len(), 1);
        assert!(list_projects(&conn, Some("/repo/a/subdir"))
            .unwrap()
            .is_empty());
        let previous = saved.clone();
        saved.goal = "Updated".into();
        saved = save_project(&mut conn, saved).unwrap();
        assert_eq!(saved.created_at, previous.created_at);
        assert!(saved.updated_at > previous.updated_at);
        assert_eq!(
            list_projects(&conn, Some("/repo/a/")).unwrap()[0].goal,
            "Updated"
        );
        delete_project(&conn, "one", "keep").unwrap();
        assert_eq!(list_projects(&conn, None).unwrap().len(), 1);
        assert!(save_project(&mut conn, saved)
            .unwrap_err()
            .contains("reload"));
        save_project(&mut conn, project("three", "/repo/c")).unwrap();
        delete_projects_for_cwd(&conn, "/repo/b/").unwrap();
        let remaining = list_projects(&conn, None).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "three");
    }

    #[test]
    fn validates_paths_ids_and_payload_bounds() {
        for path in [
            "",
            "~",
            "relative/path",
            "/../escape",
            "C:relative",
            "//server",
            "/repo\nbad",
        ] {
            assert!(normalize_cwd(path).is_err(), "{path}");
        }
        assert_eq!(normalize_cwd("C:\\Repo\\Folder\\..\\").unwrap(), "c:/repo");
        assert_eq!(normalize_cwd("C:").unwrap(), "c:/");
        assert_eq!(normalize_cwd("C:/").unwrap(), "c:/");
        assert_eq!(normalize_cwd("C:\\RÉPO").unwrap(), "c:/répo");
        assert_eq!(
            normalize_cwd("\\\\Server\\Share\\Repo\\").unwrap(),
            "//server/share/repo"
        );
        assert_eq!(normalize_cwd("/Repo/path").unwrap(), "/Repo/path");
        let mut invalid = project("../bad", "/repo");
        assert!(validate(&mut invalid).is_err());
        invalid.id = "valid".into();
        invalid.documents[0].content = "é".repeat(16_001);
        assert!(validate(&mut invalid).is_err());
        invalid.documents[0].content = "x".repeat(32_000);
        invalid.documents = (0..9)
            .map(|i| AgentProjectDocument {
                id: format!("doc-{i}"),
                ..invalid.documents[0].clone()
            })
            .collect();
        assert!(validate(&mut invalid).unwrap_err().contains("256000"));
        let mut invalid = project("valid", "/repo");
        invalid.subscriptions.push(subscription("sub", true));
        for interval in [0, 14, 10_081] {
            invalid.subscriptions[0].interval_minutes = interval;
            assert!(validate(&mut invalid).is_err());
        }
        invalid.subscriptions[0].interval_minutes = 15;
        invalid.subscriptions[0].next_run_at = -1;
        assert!(validate(&mut invalid).is_err());
        invalid.subscriptions[0].next_run_at = 0;
        invalid.subscriptions.push(invalid.subscriptions[0].clone());
        assert!(validate(&mut invalid).is_err());
        let mut crowded = project("crowded", "/repo");
        crowded.members = (0..65)
            .map(|index| member(&format!("worker-{index}"), AgentProjectRole::Worker))
            .collect();
        assert!(validate(&mut crowded).unwrap_err().contains("64 members"));
        assert_eq!(crowded.members.len(), 65);
        let mut value = serde_json::to_value(project("valid", "/repo")).unwrap();
        value["members"] = serde_json::json!([{"sessionId":"s", "role":"system", "title":"Task"}]);
        assert!(serde_json::from_value::<AgentProject>(value).is_err());
    }

    #[test]
    fn cas_and_membership_constraints_are_transactional() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let mut one = project("one", "/repo");
        one.members
            .push(member("session", AgentProjectRole::Coordinator));
        let saved = save_project(&mut conn, one).unwrap();
        let mut stale = saved.clone();
        stale.goal = "New goal".into();
        save_project(&mut conn, stale.clone()).unwrap();
        assert!(save_project(&mut conn, stale)
            .unwrap_err()
            .contains("reload"));
        let mut two = project("two", "/repo");
        two.members
            .push(member("session", AgentProjectRole::Worker));
        assert!(save_project(&mut conn, two)
            .unwrap_err()
            .contains("another project"));
        assert_eq!(list_projects(&conn, None).unwrap().len(), 1);
        let mut saved = list_projects(&conn, None).unwrap().remove(0);
        saved
            .members
            .push(member("other", AgentProjectRole::Coordinator));
        assert!(save_project(&mut conn, saved)
            .unwrap_err()
            .contains("one coordinator"));
    }

    #[test]
    fn claims_coalesce_and_invalidate_stale_saves() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let mut one = project("one", "/repo");
        one.subscriptions = vec![subscription("due", true), subscription("disabled", false)];
        let stale = save_project(&mut conn, one).unwrap();
        let mut archived = project("archived", "/repo");
        archived.archived = true;
        archived
            .subscriptions
            .push(subscription("archived-sub", true));
        save_project(&mut conn, archived).unwrap();
        let now = 100_000_000;
        let claimed = claim_due(&mut conn, now).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].subscription.next_run_at, now + 900_000);
        assert!(claimed[0].project.updated_at > stale.updated_at);
        assert!(claim_due(&mut conn, now).unwrap().is_empty());
        assert!(save_project(&mut conn, stale)
            .unwrap_err()
            .contains("reload"));
        assert_eq!(claim_due(&mut conn, now + 900_000).unwrap().len(), 1);
        assert!(claim_due(&mut conn, -1).is_err());
        assert!(claim_due(&mut conn, MAX_SAFE_INTEGER).is_err());
    }

    #[test]
    fn concurrent_windows_cannot_claim_the_same_subscription() {
        let store = Arc::new(SessionStore::open_in_memory().unwrap());
        let mut one = project("one", "/repo");
        one.subscriptions.push(subscription("due", true));
        save_project(&mut store.lock_conn().unwrap(), one).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    claim_due(&mut store.lock_conn().unwrap(), 100)
                        .unwrap()
                        .len()
                })
            })
            .collect();
        let total: usize = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .sum();
        assert_eq!(total, 1);
    }

    #[test]
    fn deleting_sessions_cleans_members_without_deleting_projects_or_chats() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        conn.execute_batch("INSERT INTO sessions(id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
            VALUES ('session', '/repo', 'codex', 'default', 'local', 'Chat', 1, 1),
                   ('keep', '/repo', 'codex', 'default', 'local', 'Keep', 1, 1);").unwrap();
        let mut one = project("one", "/repo");
        one.members
            .push(member("session", AgentProjectRole::Coordinator));
        let stale = save_project(&mut conn, one).unwrap();
        conn.execute("DELETE FROM sessions WHERE id = 'session'", [])
            .unwrap();
        let saved = list_projects(&conn, None).unwrap().remove(0);
        assert!(saved.members.is_empty());
        assert!(saved.updated_at > stale.updated_at);
        assert!(save_project(&mut conn, stale)
            .unwrap_err()
            .contains("reload"));
        delete_project(&conn, "one", "keep").unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_legacy_creates_defaults_and_assigns_sessions() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        conn.execute_batch(
            "INSERT INTO sessions(id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
             VALUES ('chat', '/repo/app', 'codex', 'default', 'local', 'Chat', 1, 1);",
        )
        .unwrap();
        let projects = migrate_legacy(
            &mut conn,
            vec![LegacyProject {
                cwd: "/repo/app".into(),
                name: "App".into(),
                archived: false,
            }],
        )
        .unwrap();
        let default = projects
            .iter()
            .find(|project| project.legacy_default && project.cwd == "/repo/app")
            .unwrap();
        assert_eq!(default.name, "App");
        let owner: String = conn
            .query_row(
                "SELECT project_id FROM sessions WHERE id = 'chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owner, default.id);
    }

    #[test]
    fn two_projects_can_share_a_repository() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        save_project(&mut conn, project("one", "/repo")).unwrap();
        save_project(&mut conn, project("two", "/repo")).unwrap();
        assert_eq!(list_projects(&conn, Some("/repo")).unwrap().len(), 2);
    }

    #[test]
    fn delete_keep_moves_chats_to_the_folder_default() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        conn.execute_batch(
            "INSERT INTO sessions(id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
             VALUES ('chat', '/repo', 'codex', 'default', 'local', 'Chat', 1, 1);",
        )
        .unwrap();
        let default = ensure_default(&conn, "/repo", Some("App"), false).unwrap();
        let extra = save_project(&mut conn, project("extra", "/repo")).unwrap();
        conn.execute(
            "UPDATE sessions SET project_id = ?1 WHERE id = 'chat'",
            params![extra.id],
        )
        .unwrap();
        delete_project(&conn, "extra", "keep").unwrap();
        let owner: String = conn
            .query_row(
                "SELECT project_id FROM sessions WHERE id = 'chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owner, default.id);
        assert!(list_projects(&conn, None)
            .unwrap()
            .iter()
            .all(|project| project.id != "extra"));
    }

    #[test]
    fn delete_disposition_can_drop_owned_chats() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        conn.execute_batch(
            "INSERT INTO sessions(id, cwd, harness, model, runtime_mode, title, created_at, updated_at, project_id)
             VALUES ('chat', '/repo', 'codex', 'default', 'local', 'Chat', 1, 1, 'one');",
        )
        .unwrap();
        save_project(&mut conn, project("one", "/repo")).unwrap();
        delete_project(&conn, "one", "delete").unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

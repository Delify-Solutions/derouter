//! Database pool — r2d2 pool over rusqlite connections with WAL + busy_timeout.
//! All DB calls run inside spawn_blocking to avoid stalling the async runtime.

use std::path::Path;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;

use crate::db::schema::PRAGMA_SQL;

pub mod migrate;
pub mod repos;
pub mod schema;

pub type DbPool = Pool<SqliteConnectionManager>;
pub type DbConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Initialize the r2d2 connection pool for the SQLite database at `db_path`.
/// Each connection gets WAL mode, busy_timeout, and foreign_keys set.
pub fn init_pool(db_path: &Path) -> anyhow::Result<DbPool> {
    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
        for pragma in PRAGMA_SQL {
            conn.execute_batch(pragma)?;
        }
        Ok(())
    });

    let pool = Pool::builder()
        .max_size(8)
        .build(manager)?;

    Ok(pool)
}

/// Run migrations on the pool
pub fn run_migrations(pool: &DbPool) -> anyhow::Result<()> {
    let conn = pool.get()?;
    migrate::run_migrations(&conn)?;
    Ok(())
}

/// Spawn a blocking task to run a DB operation on a pooled connection.
/// Usage: `let result = db_query(&pool, |conn| { ... }).await?;`
pub async fn db_query<F, R>(pool: &DbPool, f: F) -> anyhow::Result<R>
where
    F: FnOnce(&Connection) -> anyhow::Result<R> + Send + 'static,
    R: Send + 'static,
{
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        f(&conn)
    })
    .await?
}

/// Like db_query but returns a connection for multiple operations
pub async fn db_with_conn<F, R>(pool: &DbPool, f: F) -> anyhow::Result<R>
where
    F: FnOnce(&Connection) -> anyhow::Result<R> + Send + 'static,
    R: Send + 'static,
{
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        f(&conn)
    })
    .await?
}

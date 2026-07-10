#include <stdio.h>
#include <stdlib.h>

#include "sqlite3.h"

static void fail(sqlite3 *database, const char *operation, int result) {
  const char *message = database == NULL ? "database unavailable" : exsqlite3_errmsg(database);
  fprintf(stderr, "%s failed (%d): %s\n", operation, result, message);
  exit(1);
}

static void execute(sqlite3 *database, const char *sql) {
  char *message = NULL;
  const int result = exsqlite3_exec(database, sql, NULL, NULL, &message);
  if (result != SQLITE_OK) {
    fprintf(stderr, "exec failed (%d): %s\n", result, message == NULL ? "unknown error" : message);
    exsqlite3_free(message);
    exit(1);
  }
}

int main(void) {
  sqlite3 *database = NULL;
  int result = exsqlite3_open(":memory:", &database);
  if (result != SQLITE_OK) {
    fail(database, "open", result);
  }

  if (exsqlite3_compileoption_used("ENABLE_RTREE") == 0) {
    fprintf(stderr, "Expo SQLite probe was compiled without ENABLE_RTREE\n");
    return 1;
  }

  execute(database,
          "CREATE TABLE restaurants(id INTEGER PRIMARY KEY, latitude REAL, longitude REAL);"
          "CREATE VIRTUAL TABLE spatial USING rtree(id, minLat, maxLat, minLon, maxLon);"
          "CREATE TRIGGER spatial_insert AFTER INSERT ON restaurants BEGIN "
          "INSERT INTO spatial VALUES(NEW.rowid, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);"
          "END;"
          "BEGIN IMMEDIATE;"
          "INSERT INTO restaurants(latitude, longitude) VALUES(37.7749, -122.4194);"
          "COMMIT;");

  exsqlite3_stmt *statement = NULL;
  result = exsqlite3_prepare_v2(database,
                               "SELECT id FROM spatial WHERE minLat <= ? AND maxLat >= ?",
                               -1,
                               &statement,
                               NULL);
  if (result != SQLITE_OK) {
    fail(database, "prepare", result);
  }
  exsqlite3_bind_double(statement, 1, 37.78);
  exsqlite3_bind_double(statement, 2, 37.77);
  if (exsqlite3_step(statement) != SQLITE_ROW) {
    fail(database, "step", exsqlite3_errcode(database));
  }
  result = exsqlite3_finalize(statement);
  if (result != SQLITE_OK) {
    fail(database, "finalize user statement", result);
  }

  int rtreeOwnedStatementCount = 0;
  statement = exsqlite3_next_stmt(database, NULL);
  while (statement != NULL) {
    rtreeOwnedStatementCount += 1;
    statement = exsqlite3_next_stmt(database, statement);
  }
  if (rtreeOwnedStatementCount == 0) {
    fprintf(stderr, "Expected sqlite3_next_stmt() to expose R-Tree-owned statements\n");
    return 1;
  }

  // Do not finalize the statements above: they belong to R-Tree, not this
  // caller. sqlite3_close() asks rtreeDisconnect() to release them exactly
  // once and should succeed without a use-after-free.
  result = exsqlite3_close(database);
  if (result != SQLITE_OK) {
    fail(database, "safe close", result);
  }

  printf("{\"compileOption\":\"ENABLE_RTREE\",\"rtreeOwnedStatementCount\":%d,\"safeClose\":true}\n",
         rtreeOwnedStatementCount);
  return 0;
}

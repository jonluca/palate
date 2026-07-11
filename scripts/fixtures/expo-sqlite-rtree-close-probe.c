#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

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

static void verify_uri_attach(sqlite3 *database) {
  char sourcePath[] = "/tmp/palate-expo-sqlite-uri.XXXXXX";
  const int descriptor = mkstemp(sourcePath);
  if (descriptor < 0 || close(descriptor) != 0) {
    fprintf(stderr, "Could not create the URI source fixture\n");
    exit(1);
  }

  sqlite3 *source = NULL;
  int result = exsqlite3_open(sourcePath, &source);
  if (result != SQLITE_OK) {
    unlink(sourcePath);
    fail(source, "open URI source fixture", result);
  }
  execute(source, "CREATE TABLE source_rows(value INTEGER NOT NULL); INSERT INTO source_rows VALUES(7);");
  result = exsqlite3_close(source);
  if (result != SQLITE_OK) {
    unlink(sourcePath);
    fail(source, "close URI source fixture", result);
  }

  char sourceUri[PATH_MAX + 64];
  if (snprintf(sourceUri,
               sizeof(sourceUri),
               "file:%s?mode=ro&immutable=1&cache=private",
               sourcePath) >= (int)sizeof(sourceUri)) {
    unlink(sourcePath);
    fprintf(stderr, "URI source fixture path was too long\n");
    exit(1);
  }

  exsqlite3_stmt *attach = NULL;
  result = exsqlite3_prepare_v2(database, "ATTACH DATABASE ? AS uri_source", -1, &attach, NULL);
  if (result != SQLITE_OK) {
    unlink(sourcePath);
    fail(database, "prepare bound URI ATTACH", result);
  }
  exsqlite3_bind_text(attach, 1, sourceUri, -1, SQLITE_TRANSIENT);
  if (exsqlite3_step(attach) != SQLITE_DONE) {
    const int stepResult = exsqlite3_errcode(database);
    exsqlite3_finalize(attach);
    unlink(sourcePath);
    fail(database, "execute bound URI ATTACH", stepResult);
  }
  result = exsqlite3_finalize(attach);
  if (result != SQLITE_OK) {
    unlink(sourcePath);
    fail(database, "finalize bound URI ATTACH", result);
  }

  exsqlite3_stmt *read = NULL;
  result = exsqlite3_prepare_v2(database, "SELECT value FROM uri_source.source_rows", -1, &read, NULL);
  if (result != SQLITE_OK || exsqlite3_step(read) != SQLITE_ROW || exsqlite3_column_int(read, 0) != 7) {
    const int readResult = result == SQLITE_OK ? exsqlite3_errcode(database) : result;
    exsqlite3_finalize(read);
    unlink(sourcePath);
    fail(database, "read bound URI source", readResult);
  }
  result = exsqlite3_finalize(read);
  if (result != SQLITE_OK) {
    unlink(sourcePath);
    fail(database, "finalize bound URI read", result);
  }

  char *writeMessage = NULL;
  result = exsqlite3_exec(database, "CREATE TABLE uri_source.must_fail(value INTEGER)", NULL, NULL, &writeMessage);
  exsqlite3_free(writeMessage);
  if (result != SQLITE_READONLY) {
    unlink(sourcePath);
    fail(database, "reject bound URI source write", result);
  }

  execute(database, "DETACH DATABASE uri_source");
  if (unlink(sourcePath) != 0) {
    fprintf(stderr, "Could not remove the URI source fixture\n");
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
  if (exsqlite3_compileoption_used("USE_URI") == 0) {
    fprintf(stderr, "Expo SQLite probe was compiled without USE_URI\n");
    return 1;
  }

  verify_uri_attach(database);

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

  printf("{\"compileOptions\":[\"ENABLE_RTREE\",\"USE_URI\"],\"uriAttachReadOnly\":true,\"rtreeOwnedStatementCount\":%d,\"safeClose\":true}\n",
         rtreeOwnedStatementCount);
  return 0;
}

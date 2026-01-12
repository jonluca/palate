import { useDrizzleStudio } from "expo-drizzle-studio-plugin";
import { useEffect, useState } from "react";
import type { SQLiteDatabase } from "expo-sqlite";
import { getDatabase } from "@/utils/db";

export function useDrizzleStudioInspector() {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);

  useEffect(() => {
    getDatabase().then(setDb).catch(console.error);
  }, []);

  useDrizzleStudio(db);
}

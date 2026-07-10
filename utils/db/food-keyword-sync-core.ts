export const DEFAULT_FOOD_KEYWORDS = [
  "food",
  "drink",
  "dish",
  "meal",
  "cuisine",
  "snack",
  "breakfast",
  "lunch",
  "dinner",
  "brunch",
  "appetizer",
  "dessert",
  "tableware",
  "utensil",
  "salad",
  "soup",
  "sandwich",
  "pizza",
  "pasta",
  "sushi",
  "burger",
  "steak",
  "chicken",
  "fish",
  "seafood",
  "meat",
  "vegetable",
  "fruit",
  "bread",
  "cake",
  "pie",
  "biscuit",
  "chopsticks",
  "baked_goods",
  "cookie",
  "ice_cream",
  "spoon",
  "fork",
  "drinking_glass",
  "cup",
  "chocolate",
  "candy",
  "beverage",
  "coffee",
  "tea",
  "wine",
  "beer",
  "cocktail",
  "juice",
  "smoothie",
  "menu",
  "plate",
  "bowl",
  "restaurant",
  "cafe",
  "dining",
  "table_setting",
  "cutlery",
] as const;

type FoodKeywordSyncBindValue = string | number;

export interface FoodKeywordSyncConnection {
  getAllAsync<T>(source: string, parameters: FoodKeywordSyncBindValue[]): Promise<T[]>;
  runAsync(source: string, parameters: FoodKeywordSyncBindValue[]): Promise<{ readonly changes: number }>;
}

export interface FoodKeywordSyncDatabase extends FoodKeywordSyncConnection {
  withExclusiveTransactionAsync(task: (transaction: FoodKeywordSyncConnection) => Promise<void>): Promise<void>;
}

export interface FoodKeywordSyncResult {
  readonly inserted: number;
  readonly reclassified: number;
  readonly inspectionReads: number;
  readonly transactionStarted: boolean;
}

interface FoodKeywordStateRow {
  readonly keyword: string;
  readonly isBuiltIn: number;
}

interface FoodKeywordSyncPlan {
  readonly missing: string[];
  readonly reclassified: string[];
}

const DEFAULT_KEYWORDS = [...DEFAULT_FOOD_KEYWORDS];
const INSPECTION_SQL = `SELECT keyword, isBuiltIn
  FROM food_keywords
  WHERE keyword IN (${DEFAULT_KEYWORDS.map(() => "?").join(", ")})`;

/**
 * Synchronize the bundled defaults without touching a healthy database.
 *
 * The read-only preflight is the complete steady-state path. Repairs are
 * planned again under one exclusive transaction so a failed insert also
 * rolls back any built-in reclassification performed before it.
 */
export async function syncDefaultFoodKeywords(
  database: FoodKeywordSyncDatabase,
  createdAt = Date.now(),
): Promise<FoodKeywordSyncResult> {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new RangeError(`createdAt must be a non-negative safe integer; received ${createdAt}.`);
  }

  const preliminaryPlan = await inspectFoodKeywordSyncPlan(database);
  if (!needsRepair(preliminaryPlan)) {
    return {
      inserted: 0,
      reclassified: 0,
      inspectionReads: 1,
      transactionStarted: false,
    };
  }

  let inserted = 0;
  let reclassified = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const plan = await inspectFoodKeywordSyncPlan(transaction);

    if (plan.reclassified.length > 0) {
      const placeholders = plan.reclassified.map(() => "?").join(", ");
      const result = await transaction.runAsync(
        `UPDATE food_keywords
          SET isBuiltIn = 1
          WHERE isBuiltIn IS NOT 1 AND keyword IN (${placeholders})`,
        plan.reclassified,
      );
      reclassified = result.changes;
    }

    if (plan.missing.length > 0) {
      const placeholders = plan.missing.map(() => "(?, 1, 1, ?)").join(", ");
      const parameters = plan.missing.flatMap((keyword) => [keyword, createdAt]);
      const result = await transaction.runAsync(
        `INSERT INTO food_keywords (keyword, enabled, isBuiltIn, createdAt)
          VALUES ${placeholders}`,
        parameters,
      );
      inserted = result.changes;
    }
  });

  return {
    inserted,
    reclassified,
    inspectionReads: 2,
    transactionStarted: true,
  };
}

async function inspectFoodKeywordSyncPlan(connection: FoodKeywordSyncConnection): Promise<FoodKeywordSyncPlan> {
  const rows = await connection.getAllAsync<FoodKeywordStateRow>(INSPECTION_SQL, DEFAULT_KEYWORDS);
  const existingByKeyword = new Map(rows.map((row) => [row.keyword, row]));
  const missing: string[] = [];
  const reclassified: string[] = [];

  for (const keyword of DEFAULT_KEYWORDS) {
    const row = existingByKeyword.get(keyword);
    if (!row) {
      missing.push(keyword);
    } else if (row.isBuiltIn !== 1) {
      reclassified.push(keyword);
    }
  }

  return { missing, reclassified };
}

function needsRepair(plan: FoodKeywordSyncPlan): boolean {
  return plan.missing.length > 0 || plan.reclassified.length > 0;
}

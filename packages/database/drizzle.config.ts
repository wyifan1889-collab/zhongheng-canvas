import { defineConfig } from "drizzle-kit";

// Generation is offline. Applying these migrations is a separate, explicit action.
export default defineConfig({
    dialect: "postgresql",
    schema: "./src/schema.ts",
    out: "./migrations",
});

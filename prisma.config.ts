import "dotenv/config";
import { defineConfig, env } from "@prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // For migrations (Prisma CLI), we use the DIRECT_URL
    url: env("DIRECT_URL"), 
  },
});
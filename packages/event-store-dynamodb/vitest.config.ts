import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
    resolve: {
        alias: {
            "@test": path.resolve(__dirname, "../../test")
        }
    },
    test: {
        globals: true,
        include: ["**/*.tests.ts"],
        testTimeout: 60000,
        globalSetup: "../../test/vitest.globalSetup.dynamodb.ts",
        pool: "forks",
        poolOptions: { forks: { singleFork: true } }
    }
})

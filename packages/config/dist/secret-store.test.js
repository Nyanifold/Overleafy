import assert from "node:assert/strict";
import test from "node:test";
import { MemorySecretStore, ProfileGitCredentials } from "./secret-store.js";
test("memory secret store isolates profiles and secret kinds", async () => {
    const store = new MemorySecretStore();
    await store.set("personal", "git-token", "token-a");
    await store.set("personal", "web-cookie", "cookie-a");
    await store.set("work", "git-token", "token-b");
    assert.equal(await store.get("personal", "git-token"), "token-a");
    assert.equal(await store.get("personal", "web-cookie"), "cookie-a");
    assert.equal(await store.get("work", "git-token"), "token-b");
    await store.delete("personal", "git-token");
    assert.equal(await store.get("personal", "git-token"), undefined);
});
test("environment token takes precedence without persistence", async () => {
    const previous = process.env.OVERLEAFY_GIT_TOKEN;
    process.env.OVERLEAFY_GIT_TOKEN = "environment-token";
    try {
        const store = new MemorySecretStore();
        await store.set("default", "git-token", "stored-token");
        const credentials = new ProfileGitCredentials(store);
        assert.equal(await credentials.getGitToken("default"), "environment-token");
    }
    finally {
        if (previous === undefined) {
            delete process.env.OVERLEAFY_GIT_TOKEN;
        }
        else {
            process.env.OVERLEAFY_GIT_TOKEN = previous;
        }
    }
});
//# sourceMappingURL=secret-store.test.js.map
import assert from "node:assert/strict";
import test from "node:test";
import { OverleafyError, } from "@nyanifold/core";
import { mergeCookies, normalizeCookie, OverleafAuthService, } from "./auth.js";
class TestSecrets {
    values = new Map();
    async get(profile, kind) {
        return this.values.get(`${profile}:${kind}`);
    }
    async set(profile, kind, value) {
        this.values.set(`${profile}:${kind}`, value);
    }
    async delete(profile, kind) {
        this.values.delete(`${profile}:${kind}`);
    }
}
test("normalizes and merges browser cookies", () => {
    assert.equal(normalizeCookie("session-value"), "overleaf_session2=session-value");
    assert.equal(mergeCookies("a=1; b=2", ["b=3; Path=/; HttpOnly", "c=4; Secure"]), "a=1; b=3; c=4");
});
test("validates an SSO browser session and lists projects", async () => {
    const fetcher = async (input, init) => {
        assert.equal(new Headers(init?.headers).get("cookie")?.includes("overleaf_session2=valid"), true);
        const url = String(input);
        if (url.endsWith("/project")) {
            return new Response('<html><meta name="ol-csrfToken" content="csrf-value"></html>', {
                headers: {
                    "set-cookie": "refreshed=one; Path=/; HttpOnly",
                },
            });
        }
        if (url.endsWith("/user/projects")) {
            return new Response(JSON.stringify({
                projects: [
                    {
                        _id: "abc123",
                        name: "SSO Paper",
                        lastUpdated: "2026-07-18T00:00:00.000Z",
                    },
                ],
            }), { headers: { "content-type": "application/json" } });
        }
        return new Response(null, { status: 404 });
    };
    const secrets = new TestSecrets();
    const auth = new OverleafAuthService(secrets, fetcher);
    const session = await auth.importCookie("work-sso", "https://overleaf.test", "valid");
    assert.equal(session.csrfToken, "csrf-value");
    assert.equal(await secrets.get("work-sso", "web-cookie"), "overleaf_session2=valid; refreshed=one");
    assert.deepEqual(await auth.listProjects("work-sso", "https://overleaf.test"), [
        {
            id: "abc123",
            name: "SSO Paper",
            lastUpdated: "2026-07-18T00:00:00.000Z",
        },
    ]);
});
test("maps a login redirect to SESSION_EXPIRED", async () => {
    const fetcher = async () => new Response(null, {
        status: 302,
        headers: { location: "/login" },
    });
    const auth = new OverleafAuthService(new TestSecrets(), fetcher);
    await assert.rejects(auth.importCookie("default", "https://overleaf.test", "expired"), (error) => error instanceof OverleafyError &&
        error.details.code === "SESSION_EXPIRED");
});
//# sourceMappingURL=auth.test.js.map
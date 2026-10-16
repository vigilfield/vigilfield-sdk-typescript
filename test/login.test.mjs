// The sign-in loader (`src/login.ts`), compiled, against a local server and a
// config directory written the way `vf login` writes one. The publish workflow
// runs this after the compile: `npm test`. Nothing here reaches the network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { LoginError, accessToken, client, load } from "../dist/login.js";

/** Every request the server got: its method, path, headers and body. */
const seen = [];
let server;
let base;

before(async () => {
    server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            seen.push({ method: request.method, path: request.url, headers: request.headers, body });
            const answer = (status, value) => {
                response.writeHead(status, { "Content-Type": "application/json" });
                response.end(JSON.stringify(value));
            };
            if (request.url === "/api/v1/oauth/token") {
                const form = new URLSearchParams(body);
                if (form.get("refresh_token") === "ended") return answer(401, { message: "expired" });
                return answer(200, { access_token: "access-1", refresh_token: "ignored", expires_in: 900 });
            }
            if (request.url === "/api/v1/users/me") return answer(200, { id: "usr-1", email: "a@example.com" });
            return answer(404, { message: "no such route" });
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;

    // The two files, in the shape `vf login` writes.
    const config = mkdtempSync(join(tmpdir(), "vigilfield-login-"));
    mkdirSync(join(config, "vigilfield"));
    writeFileSync(
        join(config, "vigilfield", "config.json"),
        JSON.stringify({
            default: "acme",
            orgs: { acme: { url: `${base}/`, team: "team-1" }, old: { url: base } },
        }),
    );
    writeFileSync(
        join(config, "vigilfield", "credentials.json"),
        JSON.stringify({ acme: { refresh_token: "refresh-1" }, old: { refresh_token: "ended" } }),
    );
    process.env.XDG_CONFIG_HOME = config;
    delete process.env.APPDATA;
});

after(() => server.close());

test("the default org's sign-in is read as vf login left it", () => {
    const login = load();
    assert.deepEqual(login, { org: "acme", url: `${base}/`, team: "team-1" });
    assert.equal(login.refreshToken, "refresh-1");
    // Printing a sign-in does not print its secret.
    assert.ok(!JSON.stringify(login).includes("refresh-1"));
    assert.equal(load("old").team, undefined);
});

test("an org nobody signed in to names the command to run", () => {
    assert.throws(() => load("nobody"), (error) => error instanceof LoginError && error.message.includes("vf login --org nobody"));
});

test("a client sends vf's refresh request once, then the access token, the team and its own name", async () => {
    seen.length = 0;
    const vigilfield = client();
    const me = await vigilfield.users.getSelf();
    await vigilfield.users.getSelf();
    assert.equal(me.id, "usr-1");

    const exchanges = seen.filter((request) => request.path === "/api/v1/oauth/token");
    // One exchange for two calls: the token is kept.
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].method, "POST");
    assert.equal(exchanges[0].headers["content-type"], "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(exchanges[0].body)), {
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
    });

    const calls = seen.filter((request) => request.path === "/api/v1/users/me");
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.equal(call.headers.authorization, "Bearer access-1");
        assert.equal(call.headers["x-vf-team-id"], "team-1");
        assert.match(call.headers["user-agent"], /^vigilfield-typescript\/\d+\.\d+\.\d+$/);
    }
});

test("the caller's own headers win", async () => {
    seen.length = 0;
    const vigilfield = client("acme", { headers: { "user-agent": "mine", "X-VF-Team-Id": "team-2" } });
    await vigilfield.users.getSelf();
    const call = seen.find((request) => request.path === "/api/v1/users/me");
    assert.equal(call.headers["user-agent"], "mine");
    assert.equal(call.headers["x-vf-team-id"], "team-2");
});

test("a sign-in that has ended says to sign in again", async () => {
    await assert.rejects(
        client("old").users.getSelf(),
        (error) => error instanceof LoginError && error.message.includes("vf login --org old"),
    );
});

test("a token is renewed two minutes before it expires, and calls made at once share one exchange", async () => {
    let clock = 0;
    let exchanges = 0;
    const send = async () => {
        exchanges += 1;
        return [200, { access_token: `access-${exchanges}`, expires_in: 900 }];
    };
    const token = accessToken({ org: "acme", url: base, refreshToken: "refresh-1" }, send, () => clock);

    assert.deepEqual(await Promise.all([token(), token(), token()]), ["access-1", "access-1", "access-1"]);
    assert.equal(exchanges, 1);
    clock = 779;
    assert.equal(await token(), "access-1");
    clock = 780;
    assert.equal(await token(), "access-2");
    assert.equal(exchanges, 2);
});

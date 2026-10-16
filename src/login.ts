/**
 * Use a `vf login` sign-in from the TypeScript SDK (ADR-0095 §7), so a script
 * needs no credential of its own.
 *
 * `vf login` keeps two files in `<config dir>/vigilfield`: `config.json` (each
 * org's API base URL and default team) and `credentials.json` (each org's
 * refresh token, readable by its owner only). This module reads them and hands
 * the generated client a function that returns an access token:
 *
 *     import { client } from "vigilfield/login";
 *
 *     const vigilfield = client();      // the default org, or client("acme")
 *
 * The function trades the refresh token at `POST /oauth/token` for a
 * 15-minute access token, keeps it, and gets the next one two minutes before
 * it expires. The refresh token is not spent: it works for the sign-in's 24
 * hours, so any number of programs use it at once. When the sign-in ends,
 * calls reject with `LoginError` until `vf login` is run again. This module
 * writes nothing. It reads files, so it runs on Node.js and not in a browser.
 *
 * Hand-written. It is published as `src/login.ts`, beside the generated
 * client, which is why it imports `./Client.js`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { VigilfieldClient } from "./Client.js";

/** The SDK gets its next access token this long before the current one expires. */
export const RENEW_BEFORE_SECONDS = 120;

/** There is no usable sign-in. The message says which `vf login` to run. */
export class LoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LoginError";
    }
}

/** One org's sign-in, as `vf login` left it. */
export interface Login {
    org: string;
    /** The org's API base URL, `https://<org>.vigilfield.com/api/v1`. */
    url: string;
    /** The team the calls act as, when `vf login --team` set one. */
    team?: string;
    /** A secret. */
    refreshToken: string;
}

/** The directory `vf` keeps its files in: the same rule as `vf` itself. */
function configDir(): string {
    let base: string | undefined;
    if (process.platform === "win32") {
        base = process.env.APPDATA;
    } else {
        base = process.env.XDG_CONFIG_HOME;
        if (!base && process.env.HOME) {
            base = join(process.env.HOME, ".config");
        }
    }
    if (!base) {
        throw new LoginError("cannot find a config directory: HOME (or APPDATA) is not set");
    }
    return join(base, "vigilfield");
}

/** A JSON file, or `undefined` when it does not exist. */
function read(path: string): unknown {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
            return undefined;
        }
        throw new LoginError(`${path}: ${(error as Error).message}`);
    }
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new LoginError(`${path}: ${(error as Error).message}`);
    }
}

/** A JSON object's field, when the value is an object and the field a string. */
function text(value: unknown, field: string): string | undefined {
    const found = entry(value, field);
    return typeof found === "string" && found !== "" ? found : undefined;
}

function entry(value: unknown, field: string): unknown {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined;
}

/** The sign-in for `org`, or for the default org (the first one signed in to). */
export function load(org?: string): Login {
    const directory = configDir();
    const config = read(join(directory, "config.json"));
    const credentials = read(join(directory, "credentials.json"));
    const name = org || text(config, "default");
    if (!name) {
        throw new LoginError("not signed in: run `vf login --org <slug>`");
    }
    const known = entry(entry(config, "orgs"), name);
    const stored = entry(credentials, name);
    if (known === undefined || stored === undefined) {
        throw new LoginError(`not signed in to ${name}: run \`vf login --org ${name}\``);
    }
    const url = text(known, "url");
    const refreshToken = text(stored, "refresh_token");
    if (!url || !refreshToken) {
        throw new LoginError(`${directory}: not the files \`vf login\` writes`);
    }
    const login: Login = { org: name, url, team: text(known, "team"), refreshToken };
    // Not listed with the other fields, so printing a sign-in does not print the secret.
    Object.defineProperty(login, "refreshToken", { enumerable: false });
    return login;
}

/** POST a form and return the status and the JSON answer. */
async function post(url: string, form: Record<string, string>): Promise<[number, unknown]> {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(60_000),
    });
    try {
        return [response.status, await response.json()];
    } catch {
        return [response.status, undefined];
    }
}

/** Trade the refresh token for an access token and its lifetime in seconds. */
async function exchange(login: Login, send: typeof post): Promise<[string, number]> {
    const { org } = login;
    // The request `vf` sends. The refresh token is answered with itself.
    const [status, answer] = await send(`${login.url.replace(/\/+$/, "")}/oauth/token`, {
        grant_type: "refresh_token",
        refresh_token: login.refreshToken,
    });
    if (status === 400 || status === 401) {
        throw new LoginError(`your sign-in to ${org} has ended: run \`vf login --org ${org}\``);
    }
    const token = text(answer, "access_token");
    if (status !== 200 || !token) {
        throw new LoginError(`sign-in to ${org}: the token request answered ${status} with no access token`);
    }
    const lifetime = entry(answer, "expires_in");
    // A lifetime the answer does not give is zero: the token is not kept.
    return [token, typeof lifetime === "number" ? lifetime : 0];
}

/**
 * A function that returns a current access token for one sign-in. Pass it as
 * the generated client's `token`. Calls made at once share one exchange.
 */
export function accessToken(
    login: Login,
    send: typeof post = post,
    now: () => number = () => performance.now() / 1000,
): () => Promise<string> {
    let token: string | undefined;
    let renewAt = 0;
    let pending: Promise<string> | undefined;
    return () => {
        if (token !== undefined && now() < renewAt) {
            return Promise.resolve(token);
        }
        pending ??= exchange(login, send)
            .then(([fresh, lifetime]) => {
                token = fresh;
                renewAt = now() + Math.max(lifetime - RENEW_BEFORE_SECONDS, 0);
                return fresh;
            })
            .finally(() => {
                pending = undefined;
            });
        return pending;
    };
}

export const USER_AGENT = "vigilfield-typescript";

/**
 * What a client built here calls itself, which the audit log records: the
 * name and the package's version, as `vigilfield-typescript/0.1.0`. A copy
 * with no `package.json` beside it sends the name alone.
 */
export function userAgent(): string {
    try {
        const manifest: unknown = createRequire(import.meta.url)("../package.json");
        const version = text(manifest, "version");
        return version ? `${USER_AGENT}/${version}` : USER_AGENT;
    } catch {
        return USER_AGENT;
    }
}

/** What `client` passes on to the generated client's constructor. */
export interface ClientOptions {
    /** More headers for every request. One named here wins. */
    headers?: Record<string, string>;
    /** The default maximum time to wait for a response in seconds. */
    timeoutInSeconds?: number;
    /** The default number of times to retry a request. */
    maxRetries?: number;
    /** A custom fetch implementation. */
    fetch?: typeof fetch;
}

/**
 * The generated client for `org`'s sign-in, or the default org's. It sends
 * the sign-in's team on every request.
 */
export function client(org?: string, options: ClientOptions = {}): VigilfieldClient {
    const login = load(org);
    const headers: Record<string, string> = { ...options.headers };
    const named = (name: string) => Object.keys(headers).some((key) => key.toLowerCase() === name);
    // Named, so the audit log tells a script from `vf`. The caller's own wins.
    if (!named("user-agent")) {
        headers["User-Agent"] = userAgent();
    }
    if (login.team && !named("x-vf-team-id")) {
        headers["x-vf-team-id"] = login.team;
    }
    return new VigilfieldClient({
        ...options,
        baseUrl: login.url.replace(/\/+$/, ""),
        token: accessToken(login),
        headers,
    });
}

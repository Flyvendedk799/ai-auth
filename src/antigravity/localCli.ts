import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeJwtClaims } from "../codex/localCli.js";
import { refreshAntigravityToken, type AntigravityOAuthIdentity } from "./oauth.js";

const EXPIRY_BUFFER_MS = 60_000;

export class AntigravityAuthError extends Error {
  constructor(message: string, readonly needsLogin: boolean) {
    super(message);
    this.name = "AntigravityAuthError";
  }
}

export class AntigravityCliCredential {
  private inMemoryRefreshed: { accessToken: string; expiresAt: number; email: string | null } | null = null;

  private async read(): Promise<AntigravityOAuthIdentity | null> {
    try {
      const path = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as {
        token?: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown };
        id_token?: unknown;
      };
      const accessToken = parsed.token?.access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) return null;

      const refreshToken = parsed.token?.refresh_token;
      const expiresAt = typeof parsed.token?.expiry === "string" ? Date.parse(parsed.token.expiry) : NaN;
      const claims = typeof parsed.id_token === "string" ? decodeJwtClaims(parsed.id_token) : null;
      const email = typeof claims?.email === "string" ? claims.email : null;

      return {
        accessToken,
        refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        email,
      };
    } catch {
      return null;
    }
  }

  private expired(expiresAt: number, now = Date.now()): boolean {
    return expiresAt - EXPIRY_BUFFER_MS <= now;
  }

  async status(): Promise<{ connected: boolean; email: string | null; expired: boolean }> {
    const identity = await this.read();
    if (!identity) return { connected: false, email: null, expired: false };
    const effective = this.inMemoryRefreshed ?? identity;
    return { connected: true, email: effective.email, expired: this.expired(effective.expiresAt) };
  }

  async identity(): Promise<AntigravityOAuthIdentity> {
    const identity = await this.read();
    if (!identity) {
      throw new AntigravityAuthError(
        "No Antigravity CLI login found on this machine. Run \gy\ there and sign in with Google, then reload.",
        true,
      );
    }

    const effective =
      this.inMemoryRefreshed && !this.expired(this.inMemoryRefreshed.expiresAt) ? this.inMemoryRefreshed : identity;
    if (!this.expired(effective.expiresAt)) return { ...identity, ...effective };

    if (!identity.refreshToken) {
      throw new AntigravityAuthError(
        "The Antigravity CLI login on this machine has expired and has no refresh token. Run \gy\ there to sign in again.",
        true,
      );
    }

    const refreshed = await refreshAntigravityToken(identity.refreshToken);
    this.inMemoryRefreshed = {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      email: refreshed.email ?? identity.email,
    };
    return {
      accessToken: this.inMemoryRefreshed.accessToken,
      refreshToken: identity.refreshToken ?? null,
      expiresAt: this.inMemoryRefreshed.expiresAt,
      email: this.inMemoryRefreshed.email
    };
  }
}

export async function readLocalAntigravityStatus(): Promise<{ connected: boolean; email: string | null; expired: boolean }> {
  return new AntigravityCliCredential().status();
}

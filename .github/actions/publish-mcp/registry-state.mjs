import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_LOOKUP_ATTEMPTS = 3;
const REGISTRY_RETRY_DELAYS_MS = [5_000, 15_000];

class RegistryLookupError extends Error {
  constructor(message, classification, attempts, cause) {
    super(message, { cause });
    this.name = "RegistryLookupError";
    this.classification = classification;
    this.attempts = attempts;
  }
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const isRetryableStatus = (status) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const isRetryableFailure = (cause) =>
  cause instanceof Error &&
  (cause.name === "AbortError" || cause.name === "TimeoutError");

const requestRegistryPage = async (url, request, wait) => {
  for (let attempt = 1; attempt <= REGISTRY_LOOKUP_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await request(url, {
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      if (isRetryableFailure(cause)) {
        if (attempt === REGISTRY_LOOKUP_ATTEMPTS)
          throw new RegistryLookupError(
            `Registry lookup failed: timeout after ${attempt} attempts`,
            "timeout",
            attempt,
            cause,
          );
      } else throw cause;
      await wait(REGISTRY_RETRY_DELAYS_MS[attempt - 1]);
      continue;
    }
    if (response.ok) return response;
    if (
      !isRetryableStatus(response.status) ||
      attempt === REGISTRY_LOOKUP_ATTEMPTS
    )
      throw new RegistryLookupError(
        `Registry lookup failed: HTTP ${response.status} after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
        `http_${response.status}`,
        attempt,
      );
    await wait(REGISTRY_RETRY_DELAYS_MS[attempt - 1]);
  }
  throw new Error("Registry lookup retry loop did not complete");
};

const writeRegistryFailureSummary = async (cause) => {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!(cause instanceof RegistryLookupError) || summaryPath === undefined)
    return;
  await appendFile(
    summaryPath,
    `### MCP Registry lookup failed\n- classification: ${cause.classification}\n- attempts: ${cause.attempts}\n`,
  );
};

/** Exact-version routes currently return false 404s; enumerate the filtered listing. */
export async function registryPublicationState(
  server,
  request = fetch,
  wait = delay,
) {
  assert.equal(typeof server?.name, "string");
  assert.equal(typeof server?.version, "string");
  const cursors = new Set();
  let cursor;
  const matches = [];
  do {
    const url = new URL(
      "https://registry.modelcontextprotocol.io/v0.1/servers",
    );
    url.search = new URLSearchParams({
      search: server.name,
      version: server.version,
      include_deleted: "true",
      limit: "100",
    }).toString();
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const response = await requestRegistryPage(url, request, wait);
    const page = await response.json();
    assert(Array.isArray(page?.servers), "Registry response omitted servers");
    assert(
      page.metadata && typeof page.metadata === "object",
      "Registry response omitted metadata",
    );
    for (const entry of page.servers) {
      assert(
        typeof entry?.server?.name === "string" &&
          typeof entry.server.version === "string",
        "Malformed registry server record",
      );
      if (
        entry.server.name === server.name &&
        entry.server.version === server.version
      )
        matches.push(entry);
    }
    cursor = page.metadata.nextCursor;
    if (cursor !== undefined) {
      assert(
        typeof cursor === "string" && cursor.length > 0 && !cursors.has(cursor),
        "Registry returned a non-advancing cursor",
      );
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  assert(
    matches.length <= 1,
    "Registry returned ambiguous exact-version records",
  );
  if (matches.length === 0) return "absent";
  assert.equal(
    matches[0]._meta?.["io.modelcontextprotocol.registry/official"]?.status,
    "active",
    "Existing registry version is not active",
  );
  assert.deepEqual(
    matches[0].server,
    server,
    "Existing registry version differs from released metadata",
  );
  return "present";
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let state;
  try {
    state = await registryPublicationState(
      JSON.parse(await readFile("server.json", "utf8")),
    );
  } catch (cause) {
    await writeRegistryFailureSummary(cause);
    throw cause;
  }
  assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `exists=${state === "present"}\n`,
  );
  process.stdout.write(
    `Registry version is ${state}; ${state === "present" ? "preserving identical published metadata" : "publication may proceed"}.\n`,
  );
}

(() => {
const chrome: any = (globalThis as any).chrome;

type NizoAction =
  | "getRawStacktracePrompt"
  | "openReplay"
  | "getUserDetails"
  | "getReplayErrors"
  | "getReplayNetworkErrors";

type PageType = "issue" | "replay" | "other";

type PageContext = {
  origin: string;
  organizationSlug: string | null;
  issueId: string | null;
  replayId: string | null;
  pageType: PageType;
};

type ReplayResolution = {
  replayId: string;
  replayUrl: string;
  source: "url" | "dom" | "dom-click" | "api";
};

type SentryFrame = {
  raw_function?: string;
  function?: string;
  filename?: string;
  abs_path?: string;
  module?: string;
  lineno?: number;
  colno?: number;
};

type SentryException = {
  type?: string;
  value?: string;
  stacktrace?: { frames?: SentryFrame[] };
  raw_stacktrace?: { frames?: SentryFrame[] };
};

type SentryEvent = {
  eventID?: string;
  title?: string;
  culprit?: string;
  platform?: string;
  user?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown>>;
  tags?: Array<{ key?: string; value?: string }>;
  entries?: Array<{ type?: string; data?: Record<string, unknown> }>;
};

type SentryReplay = {
  id?: string;
  count_errors?: number;
  error_ids?: string[] | null;
  project_id?: string | number;
  project?: string | { id?: string | number; slug?: string };
};

function getAccessibleDocuments(): Document[] {
  const docs: Document[] = [];
  const seen = new Set<Document>();

  function walk(doc: Document): void {
    if (seen.has(doc)) {
      return;
    }
    seen.add(doc);
    docs.push(doc);

    const frames = Array.from(doc.querySelectorAll("iframe"));
    for (const frame of frames) {
      try {
        const childDoc = frame.contentDocument;
        if (childDoc) {
          walk(childDoc);
        }
      } catch {
        continue;
      }
    }
  }

  walk(document);
  return docs;
}

function queryAllDeepInRoot<T extends Element>(root: ParentNode, selector: string): T[] {
  const results: T[] = [];
  const visitedRoots = new Set<ParentNode>();

  function walk(currentRoot: ParentNode): void {
    if (visitedRoots.has(currentRoot)) {
      return;
    }
    visitedRoots.add(currentRoot);

    const scoped = Array.from(
      (currentRoot as Document | Element | ShadowRoot).querySelectorAll<T>(selector)
    );
    results.push(...scoped);

    const allElements = Array.from(
      (currentRoot as Document | Element | ShadowRoot).querySelectorAll("*")
    );
    for (const element of allElements) {
      const withShadow = element as HTMLElement & { shadowRoot?: ShadowRoot | null };
      if (withShadow.shadowRoot) {
        walk(withShadow.shadowRoot);
      }
    }
  }

  walk(root);
  return results;
}

function queryAllEverywhere<T extends Element>(selector: string): T[] {
  const elements: T[] = [];
  const seen = new Set<Element>();
  const docs = getAccessibleDocuments();

  for (const doc of docs) {
    const found = queryAllDeepInRoot<T>(doc, selector);
    for (const element of found) {
      if (seen.has(element)) {
        continue;
      }
      seen.add(element);
      elements.push(element);
    }
  }

  return elements;
}

function queryFirstEverywhere<T extends Element>(selector: string): T | null {
  const all = queryAllEverywhere<T>(selector);
  return all.length ? all[0] : null;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function firstPathMatch(pathname: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match && match[1]) {
      return decodeSafe(match[1]);
    }
  }
  return null;
}

function inferOrganizationSlugFromDom(): string | null {
  const links = queryAllEverywhere<HTMLAnchorElement>('a[href*="/organizations/"]');
  for (const link of links) {
    const href = link.getAttribute("href") || link.href;
    if (!href) {
      continue;
    }
    try {
      const parsed = new URL(href, window.location.origin);
      const match = parsed.pathname.match(/^\/organizations\/([^/]+)\//);
      if (match && match[1]) {
        return decodeSafe(match[1]);
      }
    } catch {
      continue;
    }
  }
  return null;
}

function getPageContext(): PageContext {
  const pathname = window.location.pathname;

  const organizationFromPath = firstPathMatch(pathname, [
    /^\/organizations\/([^/]+)\//,
    /^\/([^/]+)\/issues\//,
    /^\/([^/]+)\/replays\//
  ]);
  const organizationSlug = organizationFromPath || inferOrganizationSlugFromDom();

  const issueId = firstPathMatch(pathname, [
    /^\/organizations\/[^/]+\/issues\/([^/?#]+)/,
    /^\/issues\/([^/?#]+)/,
    /^\/[^/]+\/issues\/([^/?#]+)/
  ]);
  if (issueId) {
    return {
      origin: window.location.origin,
      organizationSlug,
      issueId,
      replayId: null,
      pageType: "issue"
    };
  }

  const replayId = firstPathMatch(pathname, [
    /^\/organizations\/[^/]+\/replays\/([^/?#]+)/,
    /^\/replays\/([^/?#]+)/,
    /^\/[^/]+\/replays\/([^/?#]+)/
  ]);
  if (replayId) {
    return {
      origin: window.location.origin,
      organizationSlug,
      issueId: null,
      replayId,
      pageType: "replay"
    };
  }

  const issueMatch = pathname.match(
    /\/issues\/([^/?#]+)/
  );
  if (issueMatch) {
    return {
      origin: window.location.origin,
      organizationSlug,
      issueId: decodeSafe(issueMatch[1]),
      replayId: null,
      pageType: "issue"
    };
  }

  const replayMatch = pathname.match(
    /\/replays\/([^/?#]+)/
  );
  if (replayMatch) {
    return {
      origin: window.location.origin,
      organizationSlug,
      issueId: null,
      replayId: decodeSafe(replayMatch[1]),
      pageType: "replay"
    };
  }

  return {
    origin: window.location.origin,
    organizationSlug: null,
    issueId: null,
    replayId: null,
    pageType: "other"
  };
}

function assertOrganization(ctx: PageContext): string {
  if (!ctx.organizationSlug) {
    throw new Error(
      "Could not detect Sentry organization from this page URL. Open an issue URL under /organizations/<org>/... for actions that query API."
    );
  }
  return ctx.organizationSlug;
}

async function sentryGet<T>(
  ctx: PageContext,
  path: string,
  query?: Record<string, string | number | Array<string | number>>
): Promise<T> {
  const url = new URL(path, ctx.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`.trim();
    const body = await response.text();
    throw new Error(`Sentry API error: ${body || fallback}`);
  }

  return (await response.json()) as T;
}

function toRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(Boolean) as Array<Record<string, unknown>>;
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).data)
  ) {
    return (value as { data: Array<Record<string, unknown>> }).data;
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).results)
  ) {
    return (value as { results: Array<Record<string, unknown>> }).results;
  }
  return [];
}

async function getLatestIssueEvent(ctx: PageContext): Promise<SentryEvent> {
  const organizationSlug = assertOrganization(ctx);
  if (!ctx.issueId) {
    throw new Error("This action requires an issue page.");
  }
  return sentryGet<SentryEvent>(
    ctx,
    `/api/0/organizations/${organizationSlug}/issues/${ctx.issueId}/events/latest/`
  );
}

function formatFrame(frame: SentryFrame): string {
  const fn = frame.raw_function || frame.function || "<anonymous>";
  const file = frame.filename || frame.abs_path || frame.module || "unknown";
  const line = frame.lineno ?? "?";
  const col = frame.colno ?? "?";
  return `${fn} (${file}:${line}:${col})`;
}

function normalizeFrames(frames: SentryFrame[] | undefined): string {
  if (!frames || !frames.length) {
    return "(no frames)";
  }
  return [...frames]
    .reverse()
    .map((frame) => `- ${formatFrame(frame)}`)
    .join("\n");
}

function getExceptionValues(event: SentryEvent): SentryException[] {
  const entries = Array.isArray(event.entries) ? event.entries : [];
  const exceptionEntry = entries.find((entry) => entry.type === "exception");
  const values = exceptionEntry?.data?.values;
  if (!Array.isArray(values)) {
    return [];
  }
  return values as SentryException[];
}

function extractRawStacktrace(event: SentryEvent): string {
  const values = getExceptionValues(event);
  if (!values.length) {
    throw new Error("No exception stacktrace found in the latest event.");
  }

  return values
    .map((exception, index) => {
      const header = `${index + 1}. ${exception.type || "Exception"}${
        exception.value ? `: ${exception.value}` : ""
      }`;
      const frames = exception.raw_stacktrace?.frames || exception.stacktrace?.frames;
      return `${header}\n${normalizeFrames(frames)}`;
    })
    .join("\n\n");
}

function buildPrompt(event: SentryEvent, stacktrace: string): string {
  const summaryItems: string[] = [];
  if (event.title) {
    summaryItems.push(`- Title: ${event.title}`);
  }
  if (event.eventID) {
    summaryItems.push(`- Event ID: ${event.eventID}`);
  }
  if (event.culprit) {
    summaryItems.push(`- Culprit: ${event.culprit}`);
  }
  if (event.platform) {
    summaryItems.push(`- Platform: ${event.platform}`);
  }
  const summary = summaryItems.length
    ? summaryItems.join("\n")
    : "- Context fields unavailable from page/API.";

  return [
    "You are a senior software engineer helping debug a Sentry production issue.",
    "",
    "Issue context:",
    summary,
    "",
    "Raw stacktrace:",
    stacktrace,
    "",
    "Tasks:",
    "1. Identify the most likely root cause and why.",
    "2. Suggest the minimum safe fix with implementation notes.",
    "3. Provide 2-3 high-signal checks/tests to validate the fix.",
    "4. Highlight any assumptions or missing telemetry."
  ].join("\n");
}

function getPageText(): string {
  const textParts: string[] = [];
  const docs = getAccessibleDocuments();
  for (const doc of docs) {
    if (doc.body?.innerText) {
      textParts.push(doc.body.innerText);
    }
    const shadowRoots = queryAllDeepInRoot<HTMLElement>(doc, "*")
      .map((el) => (el as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot)
      .filter((root): root is ShadowRoot => Boolean(root));
    for (const shadowRoot of shadowRoots) {
      const shadowText = shadowRoot.textContent?.trim() || "";
      if (shadowText) {
        textParts.push(shadowText);
      }
    }
  }
  return textParts.join("\n");
}

function getIssueTitleFromDom(): string | null {
  const selectors = [
    '[data-test-id="issue-title"]',
    '[data-testid="issue-title"]',
    '[data-test-id="issue-header"] h1',
    "main h1",
    "h1"
  ];

  for (const selector of selectors) {
    const el = queryFirstEverywhere<HTMLElement>(selector);
    const text = el?.textContent?.trim() || "";
    if (text && text.length > 3) {
      return text;
    }
  }

  const titleFromDocument = document.title
    .replace(/\s+\|\s+Sentry.*$/i, "")
    .replace(/\s+\|\s+Issue.*$/i, "")
    .trim();
  return titleFromDocument || null;
}

function getEventIdFromDom(): string | null {
  const pageText = getPageText();
  const match = pageText.match(/\bEvent ID:\s*([a-zA-Z0-9]+)/i);
  return match ? match[1] : null;
}

function isStackNoiseLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  const exactNoise = new Set([
    "stack trace",
    "most relevant",
    "full stack trace",
    "newest",
    "display",
    "unsymbolicated",
    "raw stack trace",
    "in app"
  ]);

  if (exactNoise.has(normalized)) {
    return true;
  }

  if (/^\d{1,2}:\d{2}\s*(am|pm)$/i.test(normalized)) {
    return true;
  }

  return false;
}

function parseFrameFromPrettyLine(line: string): {
  functionName: string;
  file: string;
  lineNo: string;
  moduleName: string | null;
} | null {
  const match = line.match(/^(.+?)\s+in\s+(.+?)\s+at line\s+(\d+)(?:\s+within\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  const file = match[1].trim();
  const functionName = match[2].trim();
  const lineNo = match[3].trim();
  const moduleName = match[4]?.trim() || null;

  if (!file || !functionName || !lineNo) {
    return null;
  }

  return { functionName, file, lineNo, moduleName };
}

function formatFrameAsRaw(
  frame: { functionName: string; file: string; lineNo: string; moduleName: string | null },
  index: number
): string {
  const location = frame.moduleName
    ? `package:${frame.moduleName}/${frame.file}:${frame.lineNo}`
    : `${frame.file}:${frame.lineNo}`;
  return `  #${index}      ${frame.functionName} (${location})`;
}

function toRawStacktraceFromSection(sectionText: string): string | null {
  const lines = sectionText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isStackNoiseLine(line));

  if (!lines.length) {
    return null;
  }

  const alreadyRawStart = lines.findIndex((line) => /^#\d+\s+/.test(line));
  if (alreadyRawStart >= 0) {
    const head = lines.slice(0, alreadyRawStart).join(" ").trim();
    const rawLines = lines.slice(alreadyRawStart);
    return [head, ...rawLines].filter(Boolean).join("\n");
  }

  const parsedFrames = lines
    .map((line) => parseFrameFromPrettyLine(line))
    .filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));

  if (!parsedFrames.length) {
    return lines.slice(0, 220).join("\n");
  }

  const firstFrameLine = lines.findIndex((line) => parseFrameFromPrettyLine(line) !== null);
  const beforeFrames = firstFrameLine > 0 ? lines.slice(0, firstFrameLine) : [];

  let header = "";
  if (beforeFrames.length >= 2 && !beforeFrames[0].includes(":")) {
    header = `${beforeFrames[0]}: ${beforeFrames[1]}`;
  } else if (beforeFrames.length >= 1) {
    header = beforeFrames[0];
  }

  const rawFrames = parsedFrames.map((frame, index) => formatFrameAsRaw(frame, index));
  return [header, ...rawFrames].filter(Boolean).join("\n");
}

function extractStacktraceFromDom(): string | null {
  const pageText = getPageText();
  const startMatch = pageText.match(/\bStack Trace\b/i);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }

  const sectionText = pageText.slice(startMatch.index);
  const endMarkers = [
    /\bSession Replay\b/i,
    /\bBreadcrumbs\b/i,
    /\bTags\b/i,
    /\bContexts\b/i,
    /\bEvent Data\b/i,
    /\bAdditional Data\b/i
  ];

  let endIndex = sectionText.length;
  for (const marker of endMarkers) {
    const markerMatch = sectionText.match(marker);
    if (
      markerMatch &&
      markerMatch.index !== undefined &&
      markerMatch.index > 20 &&
      markerMatch.index < endIndex
    ) {
      endIndex = markerMatch.index;
    }
  }

  const rawSection = sectionText.slice(0, endIndex);
  const normalized = toRawStacktraceFromSection(rawSection);
  if (!normalized || normalized.length < 30) {
    return null;
  }

  return normalized;
}

function parseReplayFromUrl(rawUrl: string): { replayId: string; replayUrl: string } | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl, window.location.origin);
    const patterns = [
      /^\/organizations\/[^/]+\/replays\/([^/?#]+)\/?$/i,
      /^\/replays\/([^/?#]+)\/?$/i,
      /^\/[^/]+\/replays\/([^/?#]+)\/?$/i
    ];

    for (const pattern of patterns) {
      const match = parsed.pathname.match(pattern);
      if (match && match[1]) {
        return {
          replayId: decodeSafe(match[1]),
          replayUrl: parsed.toString()
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getReplayCtaElements(): HTMLElement[] {
  const ctaPhrases = ["see full replay", "see all replays", "open replay", "view replay"];
  return queryAllEverywhere<HTMLElement>(
    "button, [role='button'], a, [data-href], [data-url]"
  ).filter((el) => {
    const text = (el.textContent || "").trim().toLowerCase();
    return ctaPhrases.some((phrase) => text.includes(phrase));
  });
}

function readReplayUrlFromElement(element: Element): string | null {
  const attrs = ["href", "data-href", "data-url", "data-to"];
  for (const attr of attrs) {
    const value = element.getAttribute(attr);
    if (value && value.includes("/replays/")) {
      return value;
    }
  }

  if (element instanceof HTMLAnchorElement && element.href.includes("/replays/")) {
    return element.href;
  }

  const onClick = element.getAttribute("onclick");
  if (onClick) {
    const match = onClick.match(/['"]([^'"]*\/replays\/[^'"]+)['"]/i);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

function extractReplayFromDom(): ReplayResolution | null {
  const ctaPhrases = ["see full replay", "see all replays", "open replay", "view replay"];

  const allAnchors = queryAllEverywhere<HTMLAnchorElement>("a[href]");
  const prioritizedAnchors = allAnchors
    .filter((anchor) => {
      const text = (anchor.textContent || "").trim().toLowerCase();
      return ctaPhrases.some((phrase) => text.includes(phrase));
    })
    .concat(allAnchors.filter((anchor) => anchor.href.includes("/replays/")));

  for (const anchor of prioritizedAnchors) {
    const parsed = parseReplayFromUrl(anchor.href);
    if (parsed) {
      return {
        replayId: parsed.replayId,
        replayUrl: parsed.replayUrl,
        source: "dom"
      };
    }
  }

  const ctaElements = getReplayCtaElements();

  for (const element of ctaElements) {
    const ownUrl = readReplayUrlFromElement(element);
    if (ownUrl) {
      const parsed = parseReplayFromUrl(ownUrl);
      if (parsed) {
        return {
          replayId: parsed.replayId,
          replayUrl: parsed.replayUrl,
          source: "dom"
        };
      }
    }

    const closestAnchor = element.closest("a[href]");
    if (closestAnchor) {
      const parsed = parseReplayFromUrl((closestAnchor as HTMLAnchorElement).href);
      if (parsed) {
        return {
          replayId: parsed.replayId,
          replayUrl: parsed.replayUrl,
          source: "dom"
        };
      }
    }
  }

  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractReplayByClickingCta(): Promise<ReplayResolution | null> {
  const ctaElements = getReplayCtaElements();
  if (!ctaElements.length) {
    return null;
  }

  const beforeUrl = window.location.href;
  ctaElements[0].click();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(200);

    const replayFromDom = extractReplayFromDom();
    if (replayFromDom) {
      return {
        ...replayFromDom,
        source: "dom-click"
      };
    }

    const replayFromLocation = parseReplayFromUrl(window.location.href);
    if (replayFromLocation) {
      if (window.location.href !== beforeUrl && window.history.length > 1) {
        window.history.back();
      }
      return {
        replayId: replayFromLocation.replayId,
        replayUrl: replayFromLocation.replayUrl,
        source: "dom-click"
      };
    }
  }

  return null;
}

async function extractReplayFromDomWithRetry(): Promise<ReplayResolution | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const replay = extractReplayFromDom();
    if (replay) {
      return replay;
    }
    await wait(250);
  }
  return null;
}

async function resolveReplay(ctx: PageContext): Promise<ReplayResolution> {
  if (ctx.replayId) {
    const organizationSlug = ctx.organizationSlug;
    return {
      replayId: ctx.replayId,
      replayUrl: organizationSlug
        ? `${ctx.origin}/organizations/${organizationSlug}/replays/${ctx.replayId}/`
        : window.location.href,
      source: "url"
    };
  }

  const domReplay = await extractReplayFromDomWithRetry();
  if (domReplay) {
    return domReplay;
  }

  const clickedReplay = await extractReplayByClickingCta();
  if (clickedReplay) {
    return clickedReplay;
  }

  const organizationSlug = ctx.organizationSlug ? assertOrganization(ctx) : null;
  if (!ctx.issueId) {
    throw new Error("No replay found on this page.");
  }
  if (!organizationSlug) {
    throw new Error("No replay link found in DOM for this issue.");
  }

  const replayRows = toRows(
    await sentryGet<unknown>(ctx, `/api/0/organizations/${organizationSlug}/replays/`, {
      query: `issue.id:${ctx.issueId}`,
      statsPeriod: "14d",
      per_page: 1,
      sort: "-started_at",
      field: ["id", "count_errors", "error_ids"]
    })
  );

  const first = replayRows[0];
  const replayId = typeof first?.id === "string" ? first.id : null;
  if (!replayId) {
    throw new Error("No replay is attached to this issue.");
  }

  return {
    replayId,
    replayUrl: `${ctx.origin}/organizations/${organizationSlug}/replays/${replayId}/`,
    source: "api"
  };
}

function tagsToRecord(tags: SentryEvent["tags"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags || []) {
    if (tag.key && tag.value) {
      result[tag.key] = tag.value;
    }
  }
  return result;
}

async function getReplayErrorEvents(
  ctx: PageContext,
  replayId: string
): Promise<Array<Record<string, unknown>>> {
  const organizationSlug = assertOrganization(ctx);
  try {
    return toRows(
      await sentryGet<unknown>(ctx, `/api/0/organizations/${organizationSlug}/events/`, {
        query: `replay_id:${replayId}`,
        field: ["title", "issue", "project", "timestamp", "id"],
        sort: "-timestamp",
        per_page: 20,
        statsPeriod: "14d"
      })
    );
  } catch {
    return [];
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractEventId(text: string): string | null {
  const match = text.match(/\b[a-f0-9]{8,32}\b/i);
  return match ? match[0] : null;
}

function extractIssueKey(text: string): string | null {
  const match = text.match(/\b[A-Z][A-Z0-9_-]+-[A-Z0-9]{2,}\b/);
  return match ? match[0] : null;
}

function extractTimestamp(text: string): string | null {
  const match = text.match(/\b\d{1,2}:\d{2}\b/);
  return match ? match[0] : null;
}

function getReplayErrorsTabElement(): HTMLElement | null {
  const candidates = queryAllEverywhere<HTMLElement>("[role='tab'], button, a");
  for (const candidate of candidates) {
    const text = normalizeText(candidate.textContent || "").toLowerCase();
    if (text === "errors" || text.startsWith("errors ")) {
      return candidate;
    }
  }
  return null;
}

function isTabActive(element: HTMLElement): boolean {
  const ariaSelected = element.getAttribute("aria-selected");
  if (ariaSelected === "true") {
    return true;
  }
  const dataState = (element.getAttribute("data-state") || "").toLowerCase();
  if (dataState === "active" || dataState === "selected") {
    return true;
  }
  const cls = (element.className || "").toLowerCase();
  return cls.includes("active") || cls.includes("selected");
}

async function ensureReplayErrorsTabSelected(): Promise<void> {
  const tab = getReplayErrorsTabElement();
  if (!tab) {
    return;
  }
  if (!isTabActive(tab)) {
    tab.click();
    await wait(350);
  }
}

function getReplayErrorRows(): HTMLElement[] {
  const selectors = [
    "table tbody tr",
    "[role='rowgroup'] [role='row']",
    "[role='grid'] [role='row']",
    "[data-test-id*='errors'] tbody tr",
    "[data-testid*='errors'] tbody tr",
    "[data-test-id*='errors'] [role='row']",
    "[data-testid*='errors'] [role='row']",
    "[data-test-id*='event'] [role='row']",
    "[data-testid*='event'] [role='row']"
  ];

  const rows: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of selectors) {
    for (const row of queryAllEverywhere<HTMLElement>(selector)) {
      if (seen.has(row)) {
        continue;
      }
      seen.add(row);
      rows.push(row);
    }
  }

  return rows.filter((row) => {
    const text = normalizeText(row.innerText || "");
    if (!text) {
      return false;
    }
    const lower = text.toLowerCase();
    if (
      lower.includes("event id") &&
      lower.includes("title") &&
      lower.includes("issue") &&
      lower.includes("timestamp")
    ) {
      return false;
    }
    return extractEventId(text) !== null || extractIssueKey(text) !== null;
  });
}

function findLikelyReplayRowContainer(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current.matches("tr, [role='row']")) {
      return current;
    }

    const text = normalizeText(current.innerText || current.textContent || "");
    const anchorCount = current.querySelectorAll("a").length;
    if (text.length > 20 && text.length < 700 && anchorCount >= 2) {
      return current;
    }

    current = current.parentElement;
  }
  return null;
}

function getReplayErrorRowsFromAnchors(): HTMLElement[] {
  const anchors = queryAllEverywhere<HTMLAnchorElement>("a");
  const eventAnchors = anchors.filter((anchor) => {
    const text = normalizeText(anchor.textContent || "");
    if (!extractEventId(text)) {
      return false;
    }

    const href = anchor.getAttribute("href") || anchor.href || "";
    if (href && !/event|issue|replay/i.test(href)) {
      return false;
    }

    return true;
  });

  const rows: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const anchor of eventAnchors) {
    const row = findLikelyReplayRowContainer(anchor);
    if (!row || seen.has(row)) {
      continue;
    }
    seen.add(row);
    rows.push(row);
  }

  return rows;
}

function parseReplayErrorRow(row: HTMLElement): Record<string, unknown> | null {
  const cells = Array.from(row.querySelectorAll<HTMLElement>("td, [role='cell']"))
    .map((cell) => normalizeText(cell.innerText || cell.textContent || ""))
    .filter(Boolean);

  let eventId: string | null = null;
  let title: string | null = null;
  let issue: string | null = null;
  let timestamp: string | null = null;

  if (cells.length >= 4) {
    eventId = extractEventId(cells[0]) || cells[0] || null;
    title = cells[1] || null;
    issue = extractIssueKey(cells[2]) || cells[2] || null;
    timestamp = extractTimestamp(cells[3]) || cells[3] || null;
  } else {
    const rowText = normalizeText(row.innerText || row.textContent || "");
    const anchors = Array.from(row.querySelectorAll<HTMLAnchorElement>("a"))
      .map((anchor) => normalizeText(anchor.textContent || ""))
      .filter(Boolean);

    eventId =
      anchors.map((text) => extractEventId(text)).find((value): value is string => Boolean(value)) ||
      extractEventId(rowText);

    issue =
      anchors.map((text) => extractIssueKey(text)).find((value): value is string => Boolean(value)) ||
      extractIssueKey(rowText);

    timestamp = extractTimestamp(rowText);

    title =
      anchors.find((text) => {
        return !extractEventId(text) && !extractIssueKey(text) && !extractTimestamp(text);
      }) || rowText;
  }

  if (!eventId && !title && !issue) {
    return null;
  }

  return {
    eventId: eventId || null,
    title: title || null,
    issue: issue || null,
    timestamp: timestamp || null
  };
}

function parseReplayEventsFromPageText(): Array<Record<string, unknown>> {
  const pageText = getPageText();
  const headerMatch = pageText.match(
    /\bEVENT ID\b[\s\S]{0,60}\bTITLE\b[\s\S]{0,60}\bISSUE\b[\s\S]{0,60}\bTIMESTAMP\b/i
  );
  if (!headerMatch || headerMatch.index === undefined) {
    return [];
  }

  const section = pageText.slice(headerMatch.index);
  const endMarkers = [
    /\bSession Replay\b/i,
    /\bBreadcrumbs\b/i,
    /\bConsole\b/i,
    /\bNetwork\b/i,
    /\bTrace\b/i,
    /\bTags\b/i
  ];

  let endIndex = section.length;
  for (const marker of endMarkers) {
    const markerMatch = section.match(marker);
    if (
      markerMatch &&
      markerMatch.index !== undefined &&
      markerMatch.index > 120 &&
      markerMatch.index < endIndex
    ) {
      endIndex = markerMatch.index;
    }
  }

  const lines = section
    .slice(0, endIndex)
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .filter((line) => !/^event id$/i.test(line))
    .filter((line) => !/^title$/i.test(line))
    .filter((line) => !/^issue$/i.test(line))
    .filter((line) => !/^timestamp$/i.test(line))
    .filter((line) => !/^project:/i.test(line))
    .filter((line) => !/^search errors$/i.test(line));

  const blocks: string[] = [];
  let current: string[] = [];

  const startsWithEventId = (line: string): boolean =>
    /^[a-f0-9]{8,32}\b/i.test(line) || /^([a-f0-9]{8,32})\s+/i.test(line);

  for (const line of lines) {
    if (startsWithEventId(line)) {
      if (current.length) {
        blocks.push(current.join(" "));
      }
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) {
    blocks.push(current.join(" "));
  }

  const parsedRows: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    const eventId =
      block.match(/^([a-f0-9]{8,32})\b/i)?.[1] ||
      extractEventId(block);
    const issue = extractIssueKey(block);
    const timestampMatches = Array.from(block.matchAll(/\b\d{1,2}:\d{2}\b/g));
    const timestamp =
      timestampMatches.length > 0
        ? timestampMatches[timestampMatches.length - 1][0]
        : null;

    if (!eventId) {
      continue;
    }

    let title = block.replace(new RegExp(`^${eventId}\\s*`, "i"), "");
    if (issue) {
      title = title.replace(issue, "");
    }
    if (timestamp) {
      title = title.replace(new RegExp(`${timestamp}\\s*$`), "");
    }
    title = normalizeText(title);

    parsedRows.push({
      eventId,
      title: title || null,
      issue: issue || null,
      timestamp: timestamp || null
    });
  }

  const unique = new Map<string, Record<string, unknown>>();
  for (const row of parsedRows) {
    const key = [
      String(row.eventId || ""),
      String(row.title || ""),
      String(row.issue || ""),
      String(row.timestamp || "")
    ].join("|");
    unique.set(key, row);
  }

  return Array.from(unique.values());
}

function toAbsoluteUrl(href: string, origin: string): string | null {
  if (!href) {
    return null;
  }
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
}

function collectReplayLinkMaps(ctx: PageContext): {
  eventLinks: Record<string, string>;
  issueLinks: Record<string, string>;
} {
  const eventLinks: Record<string, string> = {};
  const issueLinks: Record<string, string> = {};

  const anchors = queryAllEverywhere<HTMLAnchorElement>("a[href]");
  for (const anchor of anchors) {
    const text = normalizeText(anchor.textContent || "");
    if (!text) {
      continue;
    }

    const href = toAbsoluteUrl(anchor.getAttribute("href") || anchor.href, ctx.origin);
    if (!href) {
      continue;
    }

    const eventId = extractEventId(text);
    if (eventId && !eventLinks[eventId]) {
      eventLinks[eventId] = href;
    }

    const issueKey = extractIssueKey(text);
    if (issueKey && !issueLinks[issueKey]) {
      issueLinks[issueKey] = href;
    }
  }

  return { eventLinks, issueLinks };
}

function extractReplayErrorCountFromDom(): number | null {
  const tab = getReplayErrorsTabElement();
  const tabText = tab ? normalizeText(tab.textContent || "") : "";
  if (tabText) {
    const tabMatch = tabText.match(/errors?\s*\(?\s*(\d+)\s*\)?/i);
    if (tabMatch) {
      return Number(tabMatch[1]);
    }
  }

  const pageText = getPageText();
  const pageMatch = pageText.match(/\b(\d+)\s+errors\b/i);
  if (pageMatch) {
    return Number(pageMatch[1]);
  }
  return null;
}

async function getReplayErrorEventsFromDomWithRetry(): Promise<Array<Record<string, unknown>>> {
  await ensureReplayErrorsTabSelected();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const rowCandidates = getReplayErrorRows();
    const anchorRowCandidates = getReplayErrorRowsFromAnchors();

    const parsedFromRows = rowCandidates
      .map((row) => parseReplayErrorRow(row))
      .filter((row): row is Record<string, unknown> => Boolean(row));
    const parsedFromAnchorRows = anchorRowCandidates
      .map((row) => parseReplayErrorRow(row))
      .filter((row): row is Record<string, unknown> => Boolean(row));
    const parsedFromText = parseReplayEventsFromPageText();

    const parsed = [...parsedFromRows, ...parsedFromAnchorRows, ...parsedFromText];

    if (parsed.length > 0) {
      const unique = new Map<string, Record<string, unknown>>();
      for (const row of parsed) {
        const key = [
          String(row.eventId || ""),
          String(row.title || ""),
          String(row.issue || ""),
          String(row.timestamp || "")
        ].join("|");
        unique.set(key, row);
      }
      return Array.from(unique.values());
    }

    await wait(250);
  }

  return [];
}

function getReplayNetworkTabElement(): HTMLElement | null {
  const candidates = queryAllEverywhere<HTMLElement>("[role='tab'], button, a");
  for (const candidate of candidates) {
    const text = normalizeText(candidate.textContent || "").toLowerCase();
    if (text === "network" || text.startsWith("network ")) {
      return candidate;
    }
  }
  return null;
}

async function ensureReplayNetworkTabSelected(): Promise<void> {
  const tab = getReplayNetworkTabElement();
  if (!tab) {
    return;
  }
  if (!isTabActive(tab)) {
    tab.click();
    await wait(400);
  }
}

function extractHttpMethod(text: string): string | null {
  const match = text.match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractStatusCode(text: string): number | null {
  const match = text.match(/\b([1-5]\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function extractDuration(text: string): string | null {
  const matches = Array.from(text.matchAll(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/gi));
  if (!matches.length) {
    return null;
  }
  return matches[matches.length - 1][0];
}

function extractHost(text: string): string | null {
  const match = text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  return match ? match[1] : null;
}

function getReplayNetworkRows(): HTMLElement[] {
  const selectors = [
    "table tbody tr",
    "[role='rowgroup'] [role='row']",
    "[role='grid'] [role='row']",
    "[data-test-id*='network'] tbody tr",
    "[data-testid*='network'] tbody tr",
    "[data-test-id*='network'] [role='row']",
    "[data-testid*='network'] [role='row']"
  ];

  const rows: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of selectors) {
    for (const row of queryAllEverywhere<HTMLElement>(selector)) {
      if (seen.has(row)) {
        continue;
      }
      seen.add(row);
      rows.push(row);
    }
  }

  return rows.filter((row) => {
    const text = normalizeText(row.innerText || row.textContent || "");
    if (!text) {
      return false;
    }
    const lower = text.toLowerCase();
    if (
      lower.includes("method") &&
      lower.includes("host") &&
      lower.includes("status")
    ) {
      return false;
    }
    return (
      extractHttpMethod(text) !== null ||
      extractStatusCode(text) !== null ||
      extractHost(text) !== null
    );
  });
}

function parseReplayNetworkRow(row: HTMLElement): Record<string, unknown> | null {
  const rowText = normalizeText(row.innerText || row.textContent || "");
  if (!rowText) {
    return null;
  }

  const cells = Array.from(row.querySelectorAll<HTMLElement>("td, [role='cell']"))
    .map((cell) => normalizeText(cell.innerText || cell.textContent || ""))
    .filter(Boolean);

  const anchor = row.querySelector<HTMLAnchorElement>("a[href]");
  const detailsUrl = anchor
    ? toAbsoluteUrl(anchor.getAttribute("href") || anchor.href, window.location.origin)
    : null;

  const rawUrlMatch = rowText.match(/https?:\/\/[^\s]+/i);
  const requestUrl = rawUrlMatch ? rawUrlMatch[0] : null;

  const method = extractHttpMethod(cells.join(" ")) || extractHttpMethod(rowText);
  const status = extractStatusCode(cells.join(" ")) || extractStatusCode(rowText);
  const duration = extractDuration(cells.join(" ")) || extractDuration(rowText);
  const timestamp = extractTimestamp(cells.join(" ")) || extractTimestamp(rowText);
  const host =
    extractHost(cells.join(" ")) ||
    (requestUrl ? (() => {
      try {
        return new URL(requestUrl).hostname;
      } catch {
        return null;
      }
    })() : null) ||
    extractHost(rowText);

  if (!method && !status && !host && !requestUrl) {
    return null;
  }

  return {
    method: method || null,
    status: status ?? null,
    host: host || null,
    requestUrl: requestUrl || null,
    duration: duration || null,
    timestamp: timestamp || null,
    detailsUrl,
    title: rowText
  };
}

function parseReplayNetworkEventsFromPageText(): Array<Record<string, unknown>> {
  const pageText = getPageText();
  const lines = pageText
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const parsed: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    if (!extractHttpMethod(line)) {
      continue;
    }
    if (!extractStatusCode(line) && !extractHost(line)) {
      continue;
    }

    const rawUrlMatch = line.match(/https?:\/\/[^\s]+/i);
    const method = extractHttpMethod(line);
    const status = extractStatusCode(line);
    const duration = extractDuration(line);
    const timestamp = extractTimestamp(line);
    const host =
      extractHost(line) ||
      (rawUrlMatch ? (() => {
        try {
          return new URL(rawUrlMatch[0]).hostname;
        } catch {
          return null;
        }
      })() : null);

    parsed.push({
      method: method || null,
      status: status ?? null,
      host: host || null,
      requestUrl: rawUrlMatch ? rawUrlMatch[0] : null,
      duration: duration || null,
      timestamp: timestamp || null,
      detailsUrl: null,
      title: line
    });
  }

  if (parsed.length === 0) {
    const blockRegex =
      /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b\s+([1-5]\d{2})\s+(https?:\/\/[^\s]+)[\s\S]{0,80}?(\d+(?:\.\d+)?ms)/gi;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(pageText)) !== null) {
      let host: string | null = null;
      try {
        host = new URL(match[3]).hostname;
      } catch {
        host = extractHost(match[3]);
      }

      parsed.push({
        method: match[1].toUpperCase(),
        status: Number(match[2]),
        host,
        requestUrl: match[3],
        duration: match[4],
        timestamp: null,
        detailsUrl: null,
        title: `${match[1].toUpperCase()} ${match[3]}`
      });
    }
  }

  const unique = new Map<string, Record<string, unknown>>();
  for (const row of parsed) {
    const key = [
      String(row.method || ""),
      String(row.status || ""),
      String(row.host || ""),
      String(row.requestUrl || ""),
      String(row.timestamp || "")
    ].join("|");
    unique.set(key, row);
  }
  return Array.from(unique.values());
}

function isNetworkErrorEntry(entry: Record<string, unknown>): boolean {
  const status = typeof entry.status === "number" ? entry.status : null;
  if (status !== null && status >= 400) {
    return true;
  }

  const title = typeof entry.title === "string" ? entry.title.toLowerCase() : "";
  const requestUrl = typeof entry.requestUrl === "string" ? entry.requestUrl.toLowerCase() : "";
  const haystack = `${title} ${requestUrl}`;
  return (
    haystack.includes("error") ||
    haystack.includes("failed") ||
    haystack.includes("timeout") ||
    haystack.includes("abort") ||
    haystack.includes("blocked") ||
    haystack.includes("refused") ||
    haystack.includes("cancel")
  );
}

function extractReplayNetworkCountFromDom(): number | null {
  const tab = getReplayNetworkTabElement();
  const tabText = tab ? normalizeText(tab.textContent || "") : "";
  if (tabText) {
    const match = tabText.match(/network\s*\(?\s*(\d+)\s*\)?/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

async function getReplayNetworkEventsFromDomWithRetry(): Promise<Array<Record<string, unknown>>> {
  await ensureReplayNetworkTabSelected();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const parsedFromRows = getReplayNetworkRows()
      .map((row) => parseReplayNetworkRow(row))
      .filter((row): row is Record<string, unknown> => Boolean(row));
    const parsedFromText = parseReplayNetworkEventsFromPageText();
    const parsed = [...parsedFromRows, ...parsedFromText];

    if (parsed.length > 0) {
      const unique = new Map<string, Record<string, unknown>>();
      for (const row of parsed) {
        const key = [
          String(row.method || ""),
          String(row.status || ""),
          String(row.host || ""),
          String(row.requestUrl || ""),
          String(row.timestamp || "")
        ].join("|");
        unique.set(key, row);
      }
      return Array.from(unique.values());
    }

    await wait(250);
  }

  return [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.-]/g, "");
    if (!cleaned) {
      return null;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function extractUrlFromText(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)"]+/i);
  return match ? match[0] : null;
}

function extractProjectRefFromReplayDetails(details: SentryReplay | null): string | null {
  if (!details) {
    return null;
  }
  if (details.project_id !== undefined && details.project_id !== null) {
    return String(details.project_id);
  }
  if (typeof details.project === "string") {
    return details.project;
  }
  if (details.project && typeof details.project === "object") {
    if (details.project.slug !== undefined && details.project.slug !== null) {
      return String(details.project.slug);
    }
    if (details.project.id !== undefined && details.project.id !== null) {
      return String(details.project.id);
    }
  }
  return null;
}

function parseNetworkRequestFromSegmentPayload(
  payload: Record<string, unknown>,
  eventTimestamp: unknown
): Record<string, unknown> | null {
  const payloadData = asObject(payload.data) || {};
  const description =
    toStringValue(payload.description) ||
    toStringValue(payloadData.description) ||
    "";
  const op =
    toStringValue(payload.op) ||
    toStringValue(payloadData.op) ||
    "";

  const requestUrl =
    toStringValue(payloadData.url) ||
    toStringValue(payloadData.request_url) ||
    toStringValue(payloadData["http.url"]) ||
    extractUrlFromText(description) ||
    null;

  const method =
    toStringValue(payloadData.method) ||
    toStringValue(payloadData["http.method"]) ||
    extractHttpMethod(description) ||
    null;

  const status =
    toNumber(payloadData.status) ??
    toNumber(payloadData.status_code) ??
    toNumber(payloadData.statusCode) ??
    toNumber(payloadData["http.status_code"]);

  const durationMs =
    toNumber(payloadData.duration) ??
    toNumber(payloadData.duration_ms) ??
    toNumber(payloadData["http.response_transfer_size"]) ??
    null;
  const duration = durationMs !== null ? `${durationMs}ms` : null;

  const host =
    toStringValue(payloadData.host) ||
    (requestUrl
      ? (() => {
          try {
            return new URL(requestUrl).hostname;
          } catch {
            return null;
          }
        })()
      : null);

  const timestamp = toStringValue(eventTimestamp) || null;

  const looksLikeNetwork = /(resource|xhr|fetch|http|network|ajax|request)/i.test(
    `${op} ${description} ${requestUrl || ""}`
  );
  if (!looksLikeNetwork) {
    return null;
  }

  if (!method && !status && !requestUrl && !host) {
    return null;
  }

  return {
    method,
    status,
    host,
    requestUrl,
    duration,
    timestamp,
    detailsUrl: null,
    title: description || `${method || "REQUEST"} ${requestUrl || host || ""}`.trim(),
    source: "api-segments"
  };
}

function extractNetworkRequestsFromSegmentNode(
  node: unknown,
  collector: Array<Record<string, unknown>>
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      extractNetworkRequestsFromSegmentNode(item, collector);
    }
    return;
  }

  const obj = asObject(node);
  if (!obj) {
    return;
  }

  const data = asObject(obj.data);
  if (data) {
    const payload = asObject(data.payload);
    const parsed = payload
      ? parseNetworkRequestFromSegmentPayload(payload, obj.timestamp ?? data.timestamp)
      : null;
    if (parsed) {
      collector.push(parsed);
    }
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value) || asObject(value)) {
      extractNetworkRequestsFromSegmentNode(value, collector);
    }
  }
}

async function getReplayNetworkEventsFromApiSegments(
  ctx: PageContext,
  organizationSlug: string,
  replayId: string,
  projectRef: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await sentryGet<unknown>(
      ctx,
      `/api/0/projects/${organizationSlug}/${projectRef}/replays/${replayId}/recording-segments/`,
      { per_page: 20 }
    );

    const collected: Array<Record<string, unknown>> = [];
    extractNetworkRequestsFromSegmentNode(raw, collected);

    const unique = new Map<string, Record<string, unknown>>();
    for (const row of collected) {
      const key = [
        String(row.method || ""),
        String(row.status || ""),
        String(row.host || ""),
        String(row.requestUrl || ""),
        String(row.timestamp || "")
      ].join("|");
      unique.set(key, row);
    }
    return Array.from(unique.values());
  } catch {
    return [];
  }
}

async function handleRawStacktracePrompt(ctx: PageContext): Promise<Record<string, unknown>> {
  if (ctx.pageType !== "issue") {
    throw new Error("Open a Sentry issue page for this action.");
  }

  const domStacktrace = extractStacktraceFromDom();
  if (domStacktrace) {
    const domEvent: SentryEvent = {
      title: getIssueTitleFromDom() || undefined,
      eventID: getEventIdFromDom() || undefined
    };
    return {
      issueTitle: domEvent.title || null,
      eventId: domEvent.eventID || null,
      source: "dom",
      prompt: buildPrompt(domEvent, domStacktrace)
    };
  }

  const event = await getLatestIssueEvent(ctx);
  const stacktrace = extractRawStacktrace(event);
  const prompt = buildPrompt(event, stacktrace);

  return {
    issueTitle: event.title || null,
    eventId: event.eventID || null,
    source: "api",
    prompt
  };
}

async function handleOpenReplay(ctx: PageContext): Promise<Record<string, unknown>> {
  const replay = await resolveReplay(ctx);
  return replay;
}

async function handleUserDetails(ctx: PageContext): Promise<Record<string, unknown>> {
  if (ctx.pageType !== "issue") {
    throw new Error("Open a Sentry issue page for this action.");
  }

  const event = await getLatestIssueEvent(ctx);
  const tags = tagsToRecord(event.tags);

  return {
    issueId: ctx.issueId,
    eventId: event.eventID || null,
    user: {
      id: event.user?.id || null,
      username: event.user?.username || null,
      email: event.user?.email || null,
      ipAddress: event.user?.ip_address || null
    },
    device: event.contexts?.device || null,
    os: event.contexts?.os || null,
    browser: event.contexts?.browser || null,
    app: event.contexts?.app || null,
    tags: {
      release: tags.release || null,
      environment: tags.environment || null,
      level: tags.level || null,
      device: tags.device || null
    }
  };
}

async function handleReplayErrors(ctx: PageContext): Promise<Record<string, unknown>> {
  const replay = await resolveReplay(ctx);
  const organizationSlug = ctx.organizationSlug || null;

  let replayDetails: SentryReplay | null = null;
  if (organizationSlug) {
    try {
      replayDetails = (await sentryGet<SentryReplay>(
        ctx,
        `/api/0/organizations/${organizationSlug}/replays/${replay.replayId}/`,
        {
          field: ["id", "count_errors", "error_ids"]
        }
      )) as SentryReplay;
    } catch {
      replayDetails = null;
    }
  }

  const errorIds =
    replayDetails && Array.isArray(replayDetails.error_ids)
      ? replayDetails.error_ids.filter((value): value is string => Boolean(value))
      : [];

  const replayEventsFromDom = await getReplayErrorEventsFromDomWithRetry();
  const replayEventsFromApi =
    organizationSlug && replayEventsFromDom.length === 0
      ? await getReplayErrorEvents(ctx, replay.replayId)
      : [];
  const replayEvents =
    replayEventsFromDom.length > 0 ? replayEventsFromDom : replayEventsFromApi;
  const linkMaps = collectReplayLinkMaps(ctx);
  const replayEventsWithLinks: Array<Record<string, unknown>> = replayEvents.map((event) => {
    const eventId = typeof event.eventId === "string" ? event.eventId : null;
    const issue = typeof event.issue === "string" ? event.issue : null;

    const eventUrl = eventId ? linkMaps.eventLinks[eventId] || null : null;
    let issueUrl = issue ? linkMaps.issueLinks[issue] || null : null;
    if (!issueUrl && organizationSlug && issue) {
      issueUrl = `${ctx.origin}/organizations/${organizationSlug}/issues/?query=${encodeURIComponent(issue)}`;
    }

    const withLinks: Record<string, unknown> = {
      ...event,
      eventUrl,
      issueUrl
    };
    return withLinks;
  });

  const issuesInReplay = Array.from(
    new Set(
      replayEventsWithLinks
        .map((event) => {
          const issue = event.issue;
          if (typeof issue === "string") {
            return issue;
          }
          return null;
        })
        .filter((issue): issue is string => Boolean(issue))
    )
  );

  const eventIdsFromDom = replayEventsWithLinks
    .map((event) => event.eventId)
    .filter((eventId): eventId is string => typeof eventId === "string" && !!eventId);

  const domErrorCount = extractReplayErrorCountFromDom();
  const totalErrors = Math.max(
    replayDetails?.count_errors || 0,
    errorIds.length,
    domErrorCount || 0,
    replayEventsWithLinks.length
  );

  const issueLinks = Array.from(
    new Set(
      replayEventsWithLinks
        .map((event) =>
          typeof event.issue === "string" && typeof event.issueUrl === "string"
            ? `${event.issue}|||${event.issueUrl}`
            : null
        )
        .filter((value): value is string => Boolean(value))
    )
  ).map((value) => {
    const [issue, url] = value.split("|||");
    return { issue, url };
  });

  return {
    replayId: replay.replayId,
    replayUrl: replay.replayUrl,
    source: replay.source,
    shouldOpenReplay: ctx.pageType !== "replay",
    totalErrors,
    errorEventIds: errorIds.length > 0 ? errorIds : eventIdsFromDom,
    issuesInReplay,
    issueLinks,
    replayEvents: replayEventsWithLinks,
    replayDataSource: replayEventsFromDom.length > 0 ? "dom" : "api",
    debug: {
      domRows: getReplayErrorRows().length,
      domAnchorRows: getReplayErrorRowsFromAnchors().length,
      domTextRows: parseReplayEventsFromPageText().length,
      eventLinks: Object.keys(linkMaps.eventLinks).length,
      issueLinks: Object.keys(linkMaps.issueLinks).length
    }
  };
}

async function handleReplayNetworkErrors(ctx: PageContext): Promise<Record<string, unknown>> {
  const replay = await resolveReplay(ctx);
  const organizationSlug = ctx.organizationSlug || null;

  if (ctx.pageType !== "replay") {
    return {
      replayId: replay.replayId,
      replayUrl: replay.replayUrl,
      source: replay.source,
      shouldOpenReplay: true,
      totalNetworkRequests: 0,
      totalNetworkErrors: 0,
      networkErrors: [],
      networkDataSource: "dom",
      note: "Replay tab opened. Run this action again on the replay page to extract network errors."
    };
  }

  let replayDetails: SentryReplay | null = null;
  if (organizationSlug) {
    try {
      replayDetails = (await sentryGet<SentryReplay>(
        ctx,
        `/api/0/organizations/${organizationSlug}/replays/${replay.replayId}/`,
        {
          field: ["id", "project_id", "project"]
        }
      )) as SentryReplay;
    } catch {
      replayDetails = null;
    }
  }

  const networkRequestsFromDom = await getReplayNetworkEventsFromDomWithRetry();
  const projectRef = extractProjectRefFromReplayDetails(replayDetails);
  const networkRequestsFromApi =
    networkRequestsFromDom.length === 0 && organizationSlug && projectRef
      ? await getReplayNetworkEventsFromApiSegments(
          ctx,
          organizationSlug,
          replay.replayId,
          projectRef
        )
      : [];
  const networkRequests =
    networkRequestsFromDom.length > 0 ? networkRequestsFromDom : networkRequestsFromApi;
  const networkErrors = networkRequests.filter((row) => isNetworkErrorEntry(row));
  const totalNetworkRequests = Math.max(
    extractReplayNetworkCountFromDom() || 0,
    networkRequests.length
  );

  const requestLinks = Array.from(
    new Set(
      networkErrors
        .map((row) =>
          typeof row.detailsUrl === "string"
            ? row.detailsUrl
            : typeof row.requestUrl === "string"
              ? row.requestUrl
              : null
        )
        .filter((url): url is string => Boolean(url))
    )
  );

  return {
    replayId: replay.replayId,
    replayUrl: replay.replayUrl,
    source: replay.source,
    shouldOpenReplay: false,
    totalNetworkRequests,
    totalNetworkErrors: networkErrors.length,
    networkErrors,
    requestLinks,
    networkDataSource: networkRequestsFromDom.length > 0 ? "dom" : "api-segments",
    debug: {
      networkRows: getReplayNetworkRows().length,
      networkFromText: parseReplayNetworkEventsFromPageText().length,
      networkFromApi: networkRequestsFromApi.length,
      projectRef: projectRef || null
    }
  };
}

async function runAction(action: NizoAction): Promise<Record<string, unknown>> {
  const ctx = getPageContext();
  switch (action) {
    case "getRawStacktracePrompt":
      return handleRawStacktracePrompt(ctx);
    case "openReplay":
      return handleOpenReplay(ctx);
    case "getUserDetails":
      return handleUserDetails(ctx);
    case "getReplayErrors":
      return handleReplayErrors(ctx);
    case "getReplayNetworkErrors":
      return handleReplayNetworkErrors(ctx);
    default:
      throw new Error("Unsupported action.");
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; action?: NizoAction },
    _sender: unknown,
    sendResponse: (response: { ok: boolean; error?: string; data?: Record<string, unknown> }) => void
  ) => {
    if (!message || message.type !== "NIZO_ACTION" || !message.action) {
      return;
    }

    void runAction(message.action)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );

    return true;
  }
);

})();

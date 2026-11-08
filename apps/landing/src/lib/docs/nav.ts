export type DocsGroup = "Start" | "Core" | "Build" | "Operate";

export type DocsPage = {
  readonly slug: string;
  readonly title: string;
  readonly group: DocsGroup;
  readonly summary: string;
  readonly contracts: ReadonlyArray<string>;
  readonly sourceFolders: ReadonlyArray<string>;
};

export const docsGroups: ReadonlyArray<DocsGroup> = ["Start", "Core", "Build", "Operate"];

export const docsPages: ReadonlyArray<DocsPage> = [
  {
    slug: "getting-started",
    title: "Getting started",
    group: "Start",
    summary: "Install Mira, define a collection, run the server, and make the first request.",
    contracts: [
      "packages/mira/EGM.md",
      "packages/mira/src/app/EGM.md",
      "packages/mira/src/http/EGM.md",
      "packages/collection/src/collection/EGM.md",
      "packages/client/src/client/EGM.md"
    ],
    sourceFolders: [
      "packages/mira/src/app",
      "packages/mira/src/databases",
      "packages/mira/src/platforms",
      "packages/mira/src/storage",
      "packages/mira/src/http",
      "packages/collection/src/collection",
      "packages/client/src/client"
    ]
  },
  {
    slug: "collections",
    title: "Collections and fields",
    group: "Core",
    summary: "Define base, auth, and view collections with fields, relations, files, and indexes.",
    contracts: [
      "packages/collection/EGM.md",
      "packages/collection/src/collection/EGM.md"
    ],
    sourceFolders: ["packages/collection/src/collection"]
  },
  {
    slug: "auth",
    title: "Auth collections and sessions",
    group: "Core",
    summary: "Add users, passwords, registration, login, JWT/cookie sessions, and manager access.",
    contracts: [
      "packages/collection/src/collection/EGM.md",
      "packages/mira/src/collection-service/EGM.md",
      "packages/mira/src/http/EGM.md",
      "packages/client/src/client/EGM.md"
    ],
    sourceFolders: [
      "packages/collection/src/collection",
      "packages/mira/src/collection-service",
      "packages/mira/src/http",
      "packages/client/src/client"
    ]
  },
  {
    slug: "rules",
    title: "Access rules",
    group: "Core",
    summary: "Control which actions each caller can perform with server-side rules.",
    contracts: [
      "packages/collection/src/rule/EGM.md",
      "packages/mira/src/rule/EGM.md",
      "packages/mira/src/app/EGM.md",
      "packages/mira/src/collection-service/EGM.md"
    ],
    sourceFolders: [
      "packages/collection/src/rule",
      "packages/mira/src/rule",
      "packages/mira/src/app",
      "packages/mira/src/collection-service"
    ]
  },
  {
    slug: "querying",
    title: "Querying and pagination",
    group: "Core",
    summary: "Filter, sort, select, expand relations, and page through records with a cursor.",
    contracts: [
      "packages/collection/src/filter/EGM.md",
      "packages/mira/src/repository/EGM.md",
      "packages/mira/src/collection-service/EGM.md",
      "packages/mira/src/http/EGM.md",
      "packages/mira/src/cache/EGM.md"
    ],
    sourceFolders: [
      "packages/collection/src/filter",
      "packages/mira/src/repository",
      "packages/mira/src/collection-service",
      "packages/mira/src/http",
      "packages/mira/src/cache"
    ]
  },
  {
    slug: "client-sdk",
    title: "Client SDK and TanStack",
    group: "Build",
    summary: "Call collections from TypeScript with typed handlers, auth, files, and TanStack options.",
    contracts: [
      "packages/client/src/client/EGM.md",
      "packages/tanstack-adapter/src/EGM.md"
    ],
    sourceFolders: ["packages/client/src/client", "packages/tanstack-adapter/src"]
  },
  {
    slug: "plugins",
    title: "Plugins, hooks, and crons",
    group: "Build",
    summary: "Add lifecycle and record hooks, admin collections, and scheduled jobs.",
    contracts: [
      "packages/mira/src/hooks/EGM.md",
      "packages/mira/src/app/EGM.md",
      "packages/mira/src/cron/EGM.md"
    ],
    sourceFolders: [
      "packages/mira/src/hooks",
      "packages/mira/src/app",
      "packages/mira/src/cron"
    ]
  },
  {
    slug: "server",
    title: "Server and operations",
    group: "Operate",
    summary: "Configure the builder, storage, auto-migration, logging, and the running process.",
    contracts: [
      "packages/mira/src/app/EGM.md",
      "packages/mira/src/config/EGM.md",
      "packages/mira/src/storage/EGM.md",
      "packages/mira/src/migrator/EGM.md",
      "packages/mira/src/dialect/EGM.md",
      "packages/mira/src/telemetry/EGM.md",
      "packages/mira/src/thumbnail/EGM.md",
      "packages/mira/src/platforms/EGM.md"
    ],
    sourceFolders: [
      "packages/mira/src/app",
      "packages/mira/src/config",
      "packages/mira/src/storage",
      "packages/mira/src/migrator",
      "packages/mira/src/dialect",
      "packages/mira/src/telemetry",
      "packages/mira/src/thumbnail",
      "packages/mira/src/platforms"
    ]
  },
  {
    slug: "http-api",
    title: "HTTP API and files",
    group: "Operate",
    summary: "Use the generated REST routes, auth headers, file uploads, and status codes.",
    contracts: ["packages/mira/src/http/EGM.md"],
    sourceFolders: ["packages/mira/src/http"]
  },
  {
    slug: "dashboard",
    title: "Dashboard plugin",
    group: "Operate",
    summary: "Install the admin dashboard, register the first superadmin, and use its API.",
    contracts: [
      "packages/dashboard/src/EGM.md",
      "packages/dashboard/src/api/EGM.md"
    ],
    sourceFolders: ["packages/dashboard/src", "packages/dashboard/src/api"]
  }
];

const slugs = docsPages.map((page) => page.slug);

if (new Set(slugs).size !== slugs.length) {
  throw new Error("Docs manifest has duplicate slugs");
}

if (slugs.some((slug) => slug.trim() === "")) {
  throw new Error("Docs manifest has an empty slug");
}

export function getDocsPage(slug: string) {
  return docsPages.find((page) => page.slug === slug);
}

export function getPrevNext(slug: string) {
  const index = docsPages.findIndex((page) => page.slug === slug);

  if (index === -1) {
    return { prev: null, next: null };
  }

  return {
    prev: index > 0 ? docsPages[index - 1] : null,
    next: index < docsPages.length - 1 ? docsPages[index + 1] : null
  };
}

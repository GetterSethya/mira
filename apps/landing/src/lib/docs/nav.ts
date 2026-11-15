export type DocsGroup = "Start" | "Basics" | "Guides" | "Reference";

export type DocsPage = {
  readonly slug: string;
  readonly title: string;
  readonly group: DocsGroup;
  readonly summary: string;
  readonly contracts: ReadonlyArray<string>;
  readonly sourceFolders: ReadonlyArray<string>;
};

export const docsGroups: ReadonlyArray<DocsGroup> = [
  "Start",
  "Basics",
  "Guides",
  "Reference"
];

export const docsPages: ReadonlyArray<DocsPage> = [
  {
    slug: "getting-started",
    title: "Getting started",
    group: "Start",
    summary: "Start a server from one file, create a post over HTTP, and read it back.",
    contracts: [
      "packages/mira/EGM.md",
      "packages/collection/src/collection/EGM.md",
      "packages/mira/src/app/EGM.md",
      "packages/mira/src/http/EGM.md"
    ],
    sourceFolders: [
      "packages/collection/src/collection",
      "packages/mira/src/app",
      "packages/mira/src/http",
      "packages/mira/src/databases",
      "packages/mira/src/platforms",
      "packages/mira/src/storage"
    ]
  },
  {
    slug: "how-mira-works",
    title: "How Mira works",
    group: "Start",
    summary: "Trace one request from a collection definition to a SQL row and back.",
    contracts: [
      "packages/collection/src/collection/EGM.md",
      "packages/mira/src/app/EGM.md",
      "packages/mira/src/http/EGM.md",
      "packages/mira/src/collection-service/EGM.md",
      "packages/mira/src/repository/EGM.md",
      "packages/mira/src/migrator/EGM.md",
      "packages/mira/src/dialect/EGM.md",
      "packages/mira/src/rule/EGM.md"
    ],
    sourceFolders: [
      "packages/collection/src/collection",
      "packages/mira/src/app",
      "packages/mira/src/http",
      "packages/mira/src/collection-service",
      "packages/mira/src/repository",
      "packages/mira/src/migrator",
      "packages/mira/src/dialect",
      "packages/mira/src/rule"
    ]
  },
  {
    slug: "collections",
    title: "Collections and fields",
    group: "Basics",
    summary: "Define base, auth, and view collections and see the fields, indexes, and tables they generate.",
    contracts: [
      "packages/collection/EGM.md",
      "packages/collection/src/collection/EGM.md"
    ],
    sourceFolders: ["packages/collection/src/collection"]
  },
  {
    slug: "rules",
    title: "Access rules",
    group: "Basics",
    summary: "Attach per-action rules that decide which rows each caller can read or write.",
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
    slug: "auth",
    title: "Auth collections and sessions",
    group: "Basics",
    summary: "Add users who can register, log in, and carry a session across requests.",
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
    slug: "querying",
    title: "Querying and pagination",
    group: "Basics",
    summary: "Filter, sort, select, expand, and page through records without skipping rows.",
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
    group: "Guides",
    summary: "Call your collections from TypeScript with typed handlers, files, and TanStack options.",
    contracts: [
      "packages/client/src/client/EGM.md",
      "packages/tanstack-adapter/src/EGM.md"
    ],
    sourceFolders: ["packages/client/src/client", "packages/tanstack-adapter/src"]
  },
  {
    slug: "plugins",
    title: "Plugins, hooks, and crons",
    group: "Guides",
    summary: "Add lifecycle and record hooks, admin collections, and scheduled jobs to a running app.",
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
    group: "Guides",
    summary: "Configure the builder, storage, migrations, telemetry, and the running process.",
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
    slug: "bun",
    title: "Bun runtime",
    group: "Guides",
    summary: "Run the same app on Bun with native filesystem, HTTP, SQLite, hashing, and images.",
    contracts: [
      "packages/mira/src/platforms/EGM.md",
      "packages/mira/src/databases/EGM.md",
      "packages/mira/src/app/EGM.md"
    ],
    sourceFolders: [
      "packages/mira/src/platforms",
      "packages/mira/src/databases",
      "packages/mira/src/http"
    ]
  },
  {
    slug: "email",
    title: "Email and auth flows",
    group: "Guides",
    summary: "Turn on SMTP and the login alert, reset, verification, email-change, and OTP flows it powers.",
    contracts: [
      "packages/mira/src/http/EGM.md",
      "packages/mira/src/app/EGM.md",
      "packages/mira/src/config/EGM.md",
      "packages/mira/src/hooks/EGM.md"
    ],
    sourceFolders: [
      "packages/mira/src/email",
      "packages/mira/src/auth",
      "packages/mira/src/http",
      "packages/mira/src/hooks"
    ]
  },
  {
    slug: "dashboard",
    title: "Dashboard plugin",
    group: "Guides",
    summary: "Install the admin dashboard, register the first superadmin, and call its API.",
    contracts: [
      "packages/dashboard/src/EGM.md",
      "packages/dashboard/src/api/EGM.md"
    ],
    sourceFolders: ["packages/dashboard/src", "packages/dashboard/src/api"]
  },
  {
    slug: "http-api",
    title: "HTTP API and files",
    group: "Reference",
    summary: "Look up every generated route, status code, upload limit, and file rule.",
    contracts: ["packages/mira/src/http/EGM.md"],
    sourceFolders: ["packages/mira/src/http"]
  },
  {
    slug: "api",
    title: "API reference",
    group: "Reference",
    summary: "Find the export, signature, and source location of any public symbol.",
    contracts: [
      "typedoc.json",
      "packages/collection/src/index.ts",
      "packages/client/src/index.ts",
      "packages/mira/src/index.ts",
      "packages/mira/src/index.bun.ts",
      "packages/tanstack-adapter/src/index.ts",
      "packages/dashboard/src/index.ts"
    ],
    sourceFolders: [
      "packages/collection/src",
      "packages/client/src",
      "packages/mira/src",
      "packages/tanstack-adapter/src",
      "packages/dashboard/src"
    ]
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

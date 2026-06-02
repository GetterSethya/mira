import { getToken } from "$lib/auth.js"

const BASE = "/_dashboard/api"

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export type ListResult<T> = { items: T[] }

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> ?? {}) },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

export function makeCollectionApi(collectionName: string) {
  const base = `${BASE}/collections/${collectionName}/records`

  return {
    listOptions: (params?: { limit?: number; after?: string | number }) => {
      const q = new URLSearchParams()
      if (params?.limit !== undefined) q.set("limit", String(params.limit))
      if (params?.after !== undefined) q.set("after", String(params.after))
      return {
        queryKey: ["collection", collectionName, "list", params] as const,
        queryFn: () => req<ListResult<Record<string, unknown>>>(`${base}?${q}`),
      }
    },

    getOneOptions: (id: string) => ({
      queryKey: ["collection", collectionName, "one", id] as const,
      queryFn: () => req<Record<string, unknown>>(`${base}/${id}`),
    }),

    create: (data: Record<string, unknown> | FormData) =>
      req<Record<string, unknown>>(base, {
        method: "POST",
        headers: data instanceof FormData ? {} : { "Content-Type": "application/json" },
        body: data instanceof FormData ? data : JSON.stringify(data),
      }),

    update: (id: string, data: Record<string, unknown> | FormData) =>
      req<Record<string, unknown>>(`${base}/${id}`, {
        method: "PATCH",
        headers: data instanceof FormData ? {} : { "Content-Type": "application/json" },
        body: data instanceof FormData ? data : JSON.stringify(data),
      }),

    delete: (id: string) => req<void>(`${base}/${id}`, { method: "DELETE" }),

    invalidationKey: () => ["collection", collectionName] as const,
  }
}

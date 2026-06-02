import { goto } from "$app/navigation"
import type { PageLoad } from "./$types"

export const load: PageLoad = async ({ url }) => {
  if (!url.searchParams.get("token")) {
    return goto("/_dashboard/login")
  }
}

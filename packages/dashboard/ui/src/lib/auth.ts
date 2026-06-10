const LOGGED_IN_KEY = "mira_dashboard_loggedin"

export function isLoggedIn(): boolean {
  return localStorage.getItem(LOGGED_IN_KEY) === "1"
}

export function setLoggedIn(): void {
  localStorage.setItem(LOGGED_IN_KEY, "1")
}

export function clearLoggedIn(): void {
  localStorage.removeItem(LOGGED_IN_KEY)
}

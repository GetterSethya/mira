const STORAGE_KEY = "mira_theme"

function createTheme() {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
  const systemDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
  const initial: "light" | "dark" = stored === "dark" || stored === "light" ? stored : systemDark ? "dark" : "light"

  let current = $state<"light" | "dark">(initial)

  if (current === "dark") {
    document.documentElement.classList.add("dark")
  } else {
    document.documentElement.classList.remove("dark")
  }
  localStorage.setItem(STORAGE_KEY, current)

  return {
    get current() {
      return current
    },
    toggle() {
      current = current === "dark" ? "light" : "dark"
    }
  }
}

export const theme = createTheme()

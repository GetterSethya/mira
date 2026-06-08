export type BreadcrumbItemLink = {
  type: "link"
  href: string
  label: string
}

export type BreadcrumbItemLeaf = {
  type: "leaf"
  label: string
}

export type BreadcrumbItem = BreadcrumbItemLink | BreadcrumbItemLeaf

export class BreadcrumbStore {
  #item = $state<BreadcrumbItem[]>([])

  get current() {
    return this.#item
  }

  set setState(value: BreadcrumbItem[]) {
    this.#item = value
  }
}

export const breadcrumbStore = new BreadcrumbStore()

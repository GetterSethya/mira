export class RecordFormStore {
  #isLoading = $state(false)

  public get isLoading() {
    return this.#isLoading
  }

  public set isLoading(value: boolean) {
    this.#isLoading = value
  }
}

export const recordFormStore = new RecordFormStore()

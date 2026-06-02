import { createFormCreator } from "@tanstack/svelte-form"
import TextField from "./components/fields/TextField.svelte"
import NumberField from "./components/fields/NumberField.svelte"
import BoolField from "./components/fields/BoolField.svelte"
import DateField from "./components/fields/DateField.svelte"
import JsonField from "./components/fields/JsonField.svelte"
import FileField from "./components/fields/FileField.svelte"
import RelationField from "./components/fields/RelationField.svelte"
import SubmitButton from "./components/form/SubmitButton.svelte"

export const { createAppForm, getFormType } = createFormCreator({
  fieldComponents: { TextField, NumberField, BoolField, DateField, JsonField, FileField, RelationField },
  formComponents: { SubmitButton },
})

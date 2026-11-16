// SOURCING: the settings frame (components/settings/settings-frame) and coss ui Select, as the Appearance page uses them; the CRM's own readings of the data model, the People records and the self binding (./queries, ./model); the native bindSelfPerson mutation (./api)
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/coss/select'
import { recordTitle } from '@/components/records/model'
import { useDataModel } from '@/components/records/queries'
import {
  SettingsBox,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { accessFor, builtInName, crmTypes } from './model'
import { useBindSelfPerson, useCrmRecords, useLifeContext } from './queries'
import { crmErrorText } from './record-fields'

/**
 * Settings, Profile: which Person record is the person signed in. It is said
 * once, here, and not on every person in the CRM. Theorem reads "I" and "me"
 * as this record and starts from it when it works out who a request is about.
 */
export function ProfileSettings() {
  const model = useDataModel().data
  const life = useLifeContext()
  const people = crmTypes(model).find((type) => builtInName(type) === 'person')
  const readable = accessFor(life.data, people).read
  const records = useCrmRecords(people, { enabled: readable })
  const bind = useBindSelfPerson()

  const self = life.data?.self
  const selfId = self?.state === 'bound' ? self.personRecordId : undefined
  const unavailable = self?.state === 'unavailable'
  const list = records.data?.records ?? []
  const items = list.map((record) => ({
    value: record.id,
    label: people ? recordTitle(people, record) : record.id,
  }))
  // The bound record may be one this list has not loaded: still show it.
  if (selfId && !items.some((item) => item.value === selfId))
    items.unshift({ value: selfId, label: selfId })

  const note = bind.isError
    ? crmErrorText(bind.error, people)
    : unavailable
      ? 'This sign-in names a workspace but not a person, so no record can be marked as you.'
      : !people
        ? life.isPending || !model
          ? 'Loading'
          : 'This workspace has no People yet. Open the CRM to set them up.'
        : !readable
          ? 'This sign-in may not read People here.'
          : records.isPending
            ? 'Loading'
            : items.length === 0
              ? 'Add yourself under People in the CRM, then choose that record here.'
              : selfId
                ? 'Theorem reads “I” and “me” as this person.'
                : 'Not set. Theorem does not know which person is asking.'

  return (
    <SettingsPage
      title="Profile"
      description="Who you are among the people Theorem knows about."
    >
      <SettingsSection title="You">
        <SettingsBox>
          <SettingsRow
            title="Your person record"
            description={
              <span role={bind.isError ? 'alert' : 'status'}>{note}</span>
            }
          >
            <Select
              items={items}
              value={selfId ?? null}
              disabled={unavailable || bind.isPending || items.length === 0}
              onValueChange={(value) => {
                if (typeof value === 'string' && value !== selfId)
                  bind.mutate(value)
              }}
            >
              <SelectTrigger
                aria-label="Your person record"
                data-appearance-recipe="ui.label"
                className="w-56 max-w-full min-h-[max(2.25rem,var(--appearance-control-min))]"
              >
                <SelectValue placeholder="Choose a person" />
              </SelectTrigger>
              <SelectPopup>
                {items.map(({ value, label }) => (
                  <SelectItem
                    key={value}
                    value={value}
                    data-appearance-recipe="ui.label"
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </SettingsRow>
        </SettingsBox>
      </SettingsSection>
    </SettingsPage>
  )
}

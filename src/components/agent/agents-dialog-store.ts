// SOURCING: zustand (whether the Agents dialog is open), kept apart from the dialog so the identity chip and the palette can open it without importing the dialog itself
import { create } from 'zustand'

export const useOrganizationAgentsDialog = create<{
  open: boolean
  setOpen: (open: boolean) => void
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }))

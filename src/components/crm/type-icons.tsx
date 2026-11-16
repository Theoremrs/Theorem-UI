// SOURCING: lucide-react (one line mark per built-in type and for the CRM's own controls; the app's Icon set has no person, building or handshake). The rail's other destinations are painted Streamline marks cut by scripts/rail-icons.mjs; there is no painted mark for the CRM yet, so its rail mark is a line icon that rests and wakes as the painted ones do
import {
  Building2,
  CalendarRange,
  Contact,
  Handshake,
  MessagesSquare,
  Shapes,
  ShieldAlert,
  Target,
  UserRound,
  Waypoints,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ObjectType } from '@/components/records/contract'
import { cn } from '@/lib/utils'
import { builtInName } from './model'
import type { BuiltIn } from './model'

const ICON: Record<BuiltIn, LucideIcon> = {
  person: UserRound,
  organization: Building2,
  relationship: Waypoints,
  activity: CalendarRange,
  commitment: Handshake,
  interaction: MessagesSquare,
  goal: Target,
  constraint: ShieldAlert,
}

/** A type's mark: its own for a built-in type, a general one for any other. */
export function TypeIcon({
  type,
  className,
}: {
  type: ObjectType | undefined
  className?: string
}) {
  const name = type ? builtInName(type) : undefined
  const Mark = name ? ICON[name] : Shapes
  return (
    <Mark
      aria-hidden
      strokeWidth={1.75}
      className={cn('size-4 shrink-0', className)}
    />
  )
}

/** A built-in type's mark by name, before the type is declared. */
export function BuiltInIcon({
  name,
  className,
}: {
  name: BuiltIn
  className?: string
}) {
  const Mark = ICON[name]
  return (
    <Mark
      aria-hidden
      strokeWidth={1.75}
      className={cn('size-4 shrink-0', className)}
    />
  )
}

/** The rail's mark for the CRM. */
export function CrmRailMark({ className }: { className?: string }) {
  return (
    <Contact
      aria-hidden
      strokeWidth={1.6}
      className={cn(
        'text-ink opacity-75 group-hover/rail:opacity-100 group-aria-[current=page]/rail:opacity-100 group-aria-pressed/rail:opacity-100',
        className,
      )}
    />
  )
}

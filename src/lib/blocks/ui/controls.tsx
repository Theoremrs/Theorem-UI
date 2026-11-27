// SOURCING: Astryx (`@astryxdesign/core`, MIT, Meta Platforms, Inc.): each
// control here is Astryx's own, given one more prop, `control`, which names
// it for the agent (reach.ts). Astryx owns how the control looks and
// behaves; the agent's change goes through the same function the visible
// control calls (onChange), or through the element itself for a press or a
// toggle (`click()`), so there is no second implementation of any of them.
import { Children, isValidElement, useMemo, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Button as AstryxButton } from '@astryxdesign/core/Button'
import type { ButtonProps } from '@astryxdesign/core/Button'
import { CheckboxInput as AstryxCheckboxInput } from '@astryxdesign/core/CheckboxInput'
import type { CheckboxInputProps } from '@astryxdesign/core/CheckboxInput'
import { NumberInput as AstryxNumberInput } from '@astryxdesign/core/NumberInput'
import type { NumberInputProps } from '@astryxdesign/core/NumberInput'
import { SegmentedControl as AstryxSegmentedControl } from '@astryxdesign/core/SegmentedControl'
import type { SegmentedControlProps } from '@astryxdesign/core/SegmentedControl'
import { Selector as AstryxSelector } from '@astryxdesign/core/Selector'
import type { SelectorProps } from '@astryxdesign/core/Selector'
import { Slider as AstryxSlider } from '@astryxdesign/core/Slider'
import type { SliderRangeProps, SliderSingleProps } from '@astryxdesign/core/Slider'
import { Switch as AstryxSwitch } from '@astryxdesign/core/Switch'
import type { SwitchProps } from '@astryxdesign/core/Switch'
import { TextInput as AstryxTextInput } from '@astryxdesign/core/TextInput'
import type { TextInputProps } from '@astryxdesign/core/TextInput'
import { ToggleButton as AstryxToggleButton } from '@astryxdesign/core/ToggleButton'
import type { ToggleButtonProps } from '@astryxdesign/core/ToggleButton'
import { mergeRefs, useControl } from './reach'
import type { Reach } from './reach'

/**
 * Astryx's Slider. Its value shows as text beside the label unless
 * `valueDisplay` says otherwise. A range slider takes no `control`. One
 * signature for each kind, so `onChange={(value) => ...}` knows its type,
 * which Astryx's single union of the two leaves implicit.
 */
export function Slider(props: SliderSingleProps & Reach): ReactNode
export function Slider(props: SliderRangeProps): ReactNode
export function Slider(props: (SliderSingleProps & Reach) | SliderRangeProps) {
  const { control, ...rest } = props as SliderSingleProps & Reach
  const single = !Array.isArray(rest.value)
  useControl(single ? control : undefined, {
    label: rest.label,
    kind: 'number',
    read: () => rest.value,
    set: (value) => {
      rest.onChange?.(value as number)
      rest.onChangeEnd?.(value as number)
    },
    min: rest.min ?? 0,
    max: rest.max ?? 100,
    step: rest.step ?? 1,
    disabled: () => Boolean(rest.isDisabled),
  })
  return <AstryxSlider valueDisplay="text" {...rest} />
}

/** Astryx's NumberInput. */
export function NumberInput({ control, ...props }: NumberInputProps & Reach) {
  useControl(control, {
    label: props.label,
    kind: 'number',
    read: () => props.value,
    set: (value) => (props.onChange as (value: number) => void)(value as number),
    ...(props.min != null && { min: props.min }),
    ...(props.max != null && { max: props.max }),
    ...(props.step != null && { step: props.step }),
    disabled: () => Boolean(props.isDisabled || props.isReadOnly),
  })
  return <AstryxNumberInput {...props} />
}

/** Astryx's Switch. The agent's change is a click on it, as a person's is. */
export function Switch({ control, ref, ...props }: SwitchProps & Reach) {
  const own = useRef<HTMLInputElement>(null)
  useControl(control, {
    label: props.label,
    kind: 'boolean',
    read: () => props.value,
    set: (value) => {
      if (value !== props.value) own.current?.click()
    },
    disabled: () => Boolean(props.isDisabled),
  })
  return <AstryxSwitch ref={mergeRefs(ref, own)} {...props} />
}

/** Astryx's CheckboxInput. The agent's change is a click on it. */
export function CheckboxInput({ control, ref, ...props }: CheckboxInputProps & Reach) {
  const own = useRef<HTMLInputElement>(null)
  useControl(control, {
    label: props.label,
    kind: 'boolean',
    read: () => props.value,
    set: (value) => {
      if (value !== props.value) own.current?.click()
    },
    disabled: () => Boolean(props.isDisabled || props.isReadOnly),
  })
  return <AstryxCheckboxInput ref={mergeRefs(ref, own)} {...props} />
}

/** Astryx's ToggleButton. The agent's change is a click on it. */
export function ToggleButton({ control, ref, ...props }: ToggleButtonProps & Reach) {
  const own = useRef<HTMLButtonElement>(null)
  useControl(control, {
    label: props.label,
    kind: 'boolean',
    read: () => Boolean(props.isPressed),
    set: (value) => {
      if (value !== Boolean(props.isPressed)) own.current?.click()
    },
    disabled: () => Boolean(props.isDisabled),
  })
  return <AstryxToggleButton ref={mergeRefs(ref, own)} {...props} />
}

/** Astryx's Button. The agent presses it with a click, as a person does. */
export function Button({ control, ref, ...props }: ButtonProps & Reach) {
  const own = useRef<HTMLButtonElement>(null)
  useControl(control, {
    label: props.label,
    kind: 'action',
    invoke: () => own.current?.click(),
    disabled: () => Boolean(props.isDisabled || props.isLoading),
  })
  return <AstryxButton ref={mergeRefs(ref, own)} {...props} />
}

/** Astryx's SegmentedControl; its items' values are the agent's choices. */
export function SegmentedControl({ control, ...props }: SegmentedControlProps & Reach) {
  const options = useMemo(
    () =>
      Children.toArray(props.children)
        .filter((child): child is ReactElement<{ value: string }> => isValidElement(child))
        .map((child) => child.props.value)
        .filter((value) => typeof value === 'string'),
    [props.children],
  )
  useControl(control, {
    label: props.label,
    kind: 'choice',
    options,
    read: () => props.value,
    set: (value) => props.onChange(value as string),
    disabled: () => Boolean(props.isDisabled),
  })
  return <AstryxSegmentedControl {...props} />
}

/** Astryx's Selector; its options' values are the agent's choices. */
export function Selector({ control, ...props }: SelectorProps & Reach) {
  const options = props.options
    .filter((option): option is { value: string } => typeof option === 'object' && option !== null && 'value' in option)
    .map((option) => option.value)
  const change = (props as { onChange?: (value: string) => void }).onChange
  useControl(control, {
    label: props.label,
    kind: 'choice',
    options,
    read: () => props.value,
    set: (value) => change?.(value as string),
    disabled: () => Boolean(props.isDisabled || props.isReadOnly),
  })
  return <AstryxSelector {...props} />
}

/** Astryx's TextInput. */
export function TextInput({ control, ...props }: TextInputProps & Reach) {
  useControl(control, {
    label: props.label,
    kind: 'text',
    read: () => props.value,
    set: (value) => (props.onChange as ((value: string) => void) | undefined)?.(value as string),
    disabled: () => Boolean(props.isDisabled || props.isReadOnly),
  })
  return <AstryxTextInput {...props} />
}

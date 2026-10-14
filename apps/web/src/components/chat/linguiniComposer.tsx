/**
 * Linguini's composer simplifications (uiFlags.hideModelPicker / hideRuntimeModePicker), kept out
 * of upstream's ChatComposer.tsx: it only swaps in these drop-in replacements. Flags are fixed at
 * startup, so with no flag set every export *is* upstream's own component or function.
 */
import { uiFlags } from "../../uiFlags";
import { ComposerControlSeparator } from "./ComposerControl";
import { renderProviderTraitsPicker as upstreamRenderProviderTraitsPicker } from "./composerProviderState";
import { ProviderModelPicker as UpstreamProviderModelPicker } from "./ProviderModelPicker";
import { Tooltip } from "../ui/tooltip";

const Nothing = () => null;
const hideModel = uiFlags.hideModelPicker === true;
const hideRuntime = uiFlags.hideRuntimeModePicker === true;

/** The model picker. */
export const ProviderModelPicker: typeof UpstreamProviderModelPicker = hideModel
  ? (Nothing as unknown as typeof UpstreamProviderModelPicker)
  : UpstreamProviderModelPicker;
/** The traits (thinking level) picker. */
export const renderProviderTraitsPicker: typeof upstreamRenderProviderTraitsPicker = hideModel
  ? () => null
  : upstreamRenderProviderTraitsPicker;
/** The separator in front of the model picker (collapsed controls). */
export const ModelPickerSeparator: typeof ComposerControlSeparator = hideModel
  ? (Nothing as unknown as typeof ComposerControlSeparator)
  : ComposerControlSeparator;
/** The runtime mode picker's tooltip, which holds the whole picker. */
export const RuntimeModeTooltip: typeof Tooltip = hideRuntime
  ? (Nothing as unknown as typeof Tooltip)
  : Tooltip;
/** The separator in front of the runtime mode picker: nothing precedes it without the model picker. */
export const RuntimeModeSeparator: typeof ComposerControlSeparator =
  hideRuntime || hideModel
    ? (Nothing as unknown as typeof ComposerControlSeparator)
    : ComposerControlSeparator;
/** The separator in front of the plan mode toggle: dropped when nothing precedes it. */
export const InteractionModeSeparator: typeof ComposerControlSeparator =
  hideRuntime && hideModel
    ? (Nothing as unknown as typeof ComposerControlSeparator)
    : ComposerControlSeparator;
/** Resting control blocks: the "mode" block goes when it would be empty (no runtime picker, no plan toggle). */
export const restingBlockShown =
  (planModeUiEnabled: boolean) =>
  (def: { readonly id: string }): boolean =>
    !(hideRuntime && !planModeUiEnabled && def.id === "mode");

<script lang="ts">
  // Icon aus dem Sprite (IconSprite.svelte muss einmal in der Wurzel eingebunden sein).
  // Bewusst ohne Logik: wird in virtuellen Listen tausendfach neu befüllt.
  import type { SpriteIconName } from './sprite';

  interface Props {
    name: SpriteIconName;
    /** Zusätzliche Klassen, z. B. "is-folder" oder "s3-ico-sm". */
    class?: string;
    /** Ohne label ist das Icon dekorativ und für Screenreader unsichtbar. */
    label?: string;
  }

  let { name, class: className = '', label }: Props = $props();
</script>

<svg
  class="s3-ico {className}"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}><use href="#i-{name}" /></svg
>

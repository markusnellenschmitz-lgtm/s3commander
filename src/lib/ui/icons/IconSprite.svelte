<script lang="ts">
  // Einmal in der Wurzel einbinden. Danach: <svg class="s3-ico"><use href="#i-folder" /></svg>
  import { SPRITE_SVG } from './sprite';
</script>

<svg aria-hidden="true" style="position: absolute; width: 0; height: 0; overflow: hidden;">
  <!-- Statischer Inhalt, zur Build-Zeit aus dem Lucide-Paket erzeugt; keine Benutzerdaten. -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html SPRITE_SVG}
</svg>

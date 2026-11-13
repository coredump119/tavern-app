// Entry of the TavernHelper hub page (th/hub.html), served on the realm origin (DEV_NOTES §9.5).
import { startHub } from '@tm/tavern-helper/hub';
import jquery from 'jquery';
import jqueryUrl from 'jquery/dist/jquery.min.js?url';
import { createHubRenderer } from './render';

// the hub's own `$`: what runs in the hub itself has no frame document to take jQuery from
Object.assign(window, { $: jquery, jQuery: jquery });

startHub(window, {
  jqueryUrl: new URL(jqueryUrl, location.href).href,
  libBase: new URL('/th/lib/', location.href).href,
  render: createHubRenderer,
});

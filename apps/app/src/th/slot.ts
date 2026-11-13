// Entry of a TavernHelper slot page (th/slot.html), served on the realm origin (DEV_NOTES §9.5).
import { startSlot } from '@tm/tavern-helper/slot';
import jqueryUrl from 'jquery/dist/jquery.min.js?url';

startSlot(window, {
  jqueryUrl: new URL(jqueryUrl, location.href).href,
  libBase: new URL('/th/lib/', location.href).href,
});

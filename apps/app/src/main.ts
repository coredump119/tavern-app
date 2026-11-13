import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { installInsetsBridge, installKeyboardInset } from './lib/insets';
import { installDynamicType } from './lib/dynamic-type';
import { installCrashCapture } from './lib/crashlog';
import { crashLogAppend, isTauri } from './lib/ipc';

// first, so a failure while the app mounts is on record too (DEV_NOTES §9.38)
if (isTauri()) installCrashCapture(crashLogAppend);
installInsetsBridge();
installKeyboardInset();
installDynamicType();

export default mount(App, { target: document.getElementById('app')! });

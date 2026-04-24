// Cryptiq Secure Line — inline SVG icon library
// Usage: el.innerHTML = cqIcons.mic;  or <i data-icon="mic"></i> auto-hydrated by cqIconsHydrate()

(function (root) {
  const svg = (body, attrs = 'stroke-width="1.75"') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ${attrs} stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  const cqIcons = {
    shield:     svg('<path d="M12 2 4 5v7c0 5.2 3.5 8.3 8 10 4.5-1.7 8-4.8 8-10V5l-8-3Z"/>'),
    shieldCheck:svg('<path d="M12 2 4 5v7c0 5.2 3.5 8.3 8 10 4.5-1.7 8-4.8 8-10V5l-8-3Z"/><path d="m9 12 2.2 2.2L15.5 9.8"/>'),
    // Phone handset with a small padlock tucked into the upper-right — the Secure Line brand mark.
    phoneLock:  svg('<path d="M16.2 14.6a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2v2.9a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.8 4a2 2 0 0 1 2-2.2h2.9a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.4 2.1L8.7 9.5a16 16 0 0 0 6 6Z"/><rect x="15.6" y="2.1" width="6.6" height="4.9" rx="0.7"/><path d="M16.9 2.1V.9a1.9 1.9 0 1 1 3.9 0v1.2"/>'),
    phone:      svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.4 2.1L8 9.7a16 16 0 0 0 6 6l1.2-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2Z"/>'),
    phoneOff:   svg('<path d="M10.7 13.3a16 16 0 0 0 3 3M3 3l18 18"/><path d="M22 16.9v3a2 2 0 0 1-2.2 2c-3 .2-6-.5-8.7-2.1M5.8 9.5A19.5 19.5 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.4 2.1L8 9.7"/>'),
    mic:        svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M19 11a7 7 0 0 1-14 0M12 18v4M8 22h8"/>'),
    micOff:     svg('<path d="M3 3 21 21"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1L9 9Z"/><path d="M15 9.3V6a3 3 0 0 0-5.9-.7"/><path d="M19 11a7 7 0 0 1-.3 2M12 18v4M8 22h8M6.8 13A7 7 0 0 1 5 11"/>'),
    hand:       svg('<path d="M7 11V6a1.5 1.5 0 1 1 3 0v4"/><path d="M10 10V4a1.5 1.5 0 1 1 3 0v6"/><path d="M13 10V5a1.5 1.5 0 1 1 3 0v7"/><path d="M16 12V8a1.5 1.5 0 1 1 3 0v7a6 6 0 0 1-6 6H11a5 5 0 0 1-3.9-1.9L3.3 14.3a1.5 1.5 0 0 1 2.4-1.8L7 14"/>'),
    // Bell = "I want to speak next" — replaces hand-raise semantics.
    bell:       svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    bellRing:   svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M3 4.5a5 5 0 0 0-2 3M21 4.5a5 5 0 0 1 2 3"/>'),
    eye:        svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
    userCheck:  svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>'),
    users:      svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
    copy:       svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    send:       svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>'),
    check:      svg('<path d="m5 12 5 5L20 7"/>'),
    x:          svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    lock:       svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/>'),
    link:       svg('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
    camera:     svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/>'),
    trash:      svg('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    plus:       svg('<path d="M12 5v14M5 12h14"/>'),
    arrowRight: svg('<path d="M5 12h14M13 5l7 7-7 7"/>'),
    waveform:   svg('<path d="M3 12h2M7 8v8M11 4v16M15 8v8M19 10v4M21 12h0"/>'),
    alert:      svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>'),
    eyeOff:     svg('<path d="M17.9 17.9A10.8 10.8 0 0 1 12 19c-6.5 0-10-7-10-7a19.4 19.4 0 0 1 5.1-5.9L17.9 17.9ZM1 1l22 22"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M9.9 4.2A10.5 10.5 0 0 1 12 4c6.5 0 10 7 10 7a19.3 19.3 0 0 1-2.4 3.2"/>'),
    logout:     svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>'),
    upload:     svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>'),
    chevronDown:svg('<path d="m6 9 6 6 6-6"/>'),
    chevronUp:  svg('<path d="m6 15 6-6 6 6"/>'),
    clock:      svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    refresh:    svg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
    sparkles:   svg('<path d="m12 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/><path d="M18 14l.8 2 2 .8-2 .8L18 20l-.8-2-2-.8 2-.8Z"/>'),
    sun:        svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v1M12 20v1M3 12h1M20 12h1M5.6 5.6l.7.7M17.7 17.7l.7.7M5.6 18.4l.7-.7M17.7 6.3l.7-.7"/>'),
    moon:       svg('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>'),
    // Face (simple smiley outline) with a diagonal slash — reads as
    // "no face shown" (i.e. voice-only call).
    faceOff:    svg('<circle cx="12" cy="12" r="9"/><path d="M9 15.5c1 1 4 1 5.5 0"/><circle cx="9" cy="10.5" r="0.7" fill="currentColor" stroke="none"/><circle cx="15" cy="10.5" r="0.7" fill="currentColor" stroke="none"/><path d="M4.5 4.5 19.5 19.5"/>'),
    // Speech bubble with three dots + diagonal slash — reads as
    // "no fake talking" (i.e. voice-clone attacks blocked).
    speakOff:   svg('<path d="M21 12a8 8 0 0 1-11.8 7L4 20.5l1.5-5.2A8 8 0 1 1 21 12Z"/><circle cx="8.5" cy="12" r="0.8" fill="currentColor" stroke="none"/><circle cx="12"  cy="12" r="0.8" fill="currentColor" stroke="none"/><circle cx="15.5" cy="12" r="0.8" fill="currentColor" stroke="none"/><path d="M4 4 20 20"/>'),
    // Speaker with an X: "call audio silenced for this listener" — used to
    // show other participants that an intruder-flagged user can't hear.
    volumeOff:  svg('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/>'),
    // Speaker with 1–2 waves: active-talker indicator (pulses when VAD fires).
    volume:     svg('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M16 8.5a5 5 0 0 1 0 7"/><path d="M19.5 5a10 10 0 0 1 0 14"/>'),
    earOff:     svg('<path d="M6 18a4 4 0 0 1-4-4c0-1 .3-2.1 1-3"/><path d="M18 4.7a6 6 0 0 1 3 5.3c0 1.2-.3 2.3-1 3.3"/><path d="M7 10a5 5 0 0 1 6.5-4.8M19 19c-1.4 2-3.5 2-5 1-1-.7-1-2.2-.3-3.3"/><path d="M3 3l18 18"/>'),
    pause:      svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
    play:       svg('<path d="M7 4 19 12 7 20Z"/>'),
  };

  root.cqIcons = cqIcons;

  root.cqIconsHydrate = function (scope) {
    (scope || document).querySelectorAll('[data-icon]').forEach((el) => {
      const key = el.getAttribute('data-icon');
      if (cqIcons[key]) el.innerHTML = cqIcons[key];
    });
  };
})(window);

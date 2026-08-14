# Arcade keyboard layout design

## Goal

Replace the unreliable Right Shift arcade coin binding with a keyboard layout
that works consistently in the embedded browser and is easy for both friends
to remember. Restore access to the on-page keyboard settings that the emulator
canvas currently covers.

## Confirmed layout

Both players use the same physical keys in their own browser:

| Arcade control | Keyboard key |
| --- | --- |
| Up / Down / Left / Right | W / S / A / D |
| A / B / C / D | J / K / U / I |
| Coin | 1 |
| Start | Enter |

The host's input is routed to RetroArch player 1. A room guest sends the same
logical controls over the existing WebRTC data channel, where the host routes
them to RetroArch player 2. Therefore both users can press `1` for coin and
`Enter` for start without a conflict.

## Implementation boundary

- Change the default keyboard mapping in `useInputMapping`.
- Keep the existing internal RetroPad-to-Neo-Geo conversion: game A/B/C/D map
  to internal `b/a/y/x`, so the physical keys become J/K/U/I in that order.
- Label arcade `select` as `投币` and arcade `start` as `开始` in the settings
  panel.
- Create the Nostalgist canvas in the application and pass it through the
  supported `element` option, so Nostalgist does not apply its fixed full-page
  canvas layout. Keep the canvas contained inside the emulator frame and leave
  the top toolbar clickable.
- Tell users in the settings panel that keyboard changes apply after reopening
  the game; live RetroArch config reload is outside this patch.
- Preserve user-customized mappings already stored in `localStorage`; the
  reset action adopts the new defaults.
- Do not add a second local keyboard player. The current product model remains
  one local host plus one remote room guest.
- Do not change ROM upload limits, room signaling, or emulator cores.

The current mapping store is per user rather than per platform. This change
updates the shared default profile because the deployed catalog is currently
arcade-only. Platform-specific profiles can be introduced separately when
non-arcade catalog content is added.

## Verification

1. Add a Node test that asserts the default physical-to-logical mapping and
   the arcade labels, plus the application-owned canvas option; confirm it
   fails before the implementation change.
2. Apply the minimal mapping, label, settings hint, and canvas ownership
   changes, then confirm the test passes.
3. Run the full production build and dependency audit.
4. Deploy through the existing release and systemd workflow.
5. In the live site, verify that clicking the canvas and pressing `1`, then
   `Enter`, changes the game from attract mode into play without using Shift.
6. Verify that the top toolbar and keyboard settings button remain visible and
   clickable while the game canvas is running.
7. Confirm the service, health timer, public API, and existing seven ROMs stay
   healthy after deployment.

// EveSkillsheet settings. The Client ID is public (it is sent in the login URL), so it is fine to commit.
// PKCE login means there is no secret key anywhere in this app.
window.SKILLSHEET_CONFIG = {
  // From https://developers.eveonline.com/applications, your EveSkillsheet application.
  clientId: 'PASTE_CLIENT_ID_HERE',

  // Must exactly match the Callback URL registered with CCP.
  // Leave null to use this site's root, e.g. https://skillsheet.crankyape.space/
  redirectUri: null,

  // Public share links for a character's sheet. Needs the D1 database (see README).
  // Off: the app is private and only for tracking your own characters.
  sharing: false,

  // ESI API version pin (X-Compatibility-Date header).
  compatibilityDate: '2025-09-30',
};

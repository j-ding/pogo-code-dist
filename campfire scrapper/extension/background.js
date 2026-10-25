// Toolbar button: toggle the panel on a Campfire tab, or open Campfire if we're elsewhere.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.startsWith('https://campfire.scopely.com/')) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
  } else {
    chrome.tabs.create({ url: 'https://campfire.scopely.com/' });
  }
});

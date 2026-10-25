// =============================================================
// Campfire Meetup Check-In Scraper
// Paste this into the browser console while on campfire.scopely.com
// Then call: getCampfireAttendees('MEETUP_URL_OR_ID')
// =============================================================

async function getCampfireAttendees(input) {
  // Extract meetup ID from URL or use raw ID
  let meetupId = input;
  const urlMatch = input.match(/meetup\/([a-f0-9-]+)/);
  if (urlMatch) meetupId = urlMatch[1];

  console.log(`%c🔥 Fetching meetup: ${meetupId}`, 'color: orange; font-size: 14px; font-weight: bold;');

  // GraphQL query reconstructed from the response schema
  const query = `query GetEvent($eventId: ID!) {
    event(id: $eventId) {
      id
      name
      address
      details
      location
      commentCount
      eventTime
      eventEndTime
      checkedInMembersCount
      visibility
      game
      club {
        id
        name
        game
      }
      creator {
        id
        displayName
        username
        avatarUrl
        badges { badgeType alias }
      }
      members {
        totalCount
        edges {
          node {
            id
            displayName
            avatarUrl
          }
        }
      }
      rsvpStatuses {
        userId
        rsvpStatus
      }
      campfireLiveEvent {
        eventName
        id
      }
    }
    me {
      id
      displayName
    }
  }`;

  try {
    const res = await fetch('https://niantic-social-api.nianticlabs.com/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'GetEvent',
        query: query,
        variables: { eventId: meetupId }
      })
    });

    const json = await res.json();

    if (json.errors) {
      console.error('GraphQL errors:', json.errors);
      return;
    }

    const event = json.data.event;
    if (!event) {
      console.error('Event not found. Check the meetup ID.');
      return;
    }

    // Build lookup maps
    const members = event.members.edges.map(e => e.node);
    const statuses = event.rsvpStatuses || [];
    const statusMap = {};
    statuses.forEach(s => { statusMap[s.userId] = s.rsvpStatus; });

    // Categorize attendees
    const checkedIn = [];
    const rsvpOnly = [];
    const unknown = [];

    members.forEach(m => {
      const status = statusMap[m.id] || 'UNKNOWN';
      const entry = { name: m.displayName, status: status, id: m.id };
      if (status === 'CHECKED_IN') checkedIn.push(entry);
      else if (status === 'ACCEPTED') rsvpOnly.push(entry);
      else unknown.push(entry);
    });

    // Display results
    console.log(`%c📍 ${event.name}`, 'color: #00bcd4; font-size: 16px; font-weight: bold;');
    console.log(`%c📅 ${new Date(event.eventTime).toLocaleString()} - ${new Date(event.eventEndTime).toLocaleString()}`, 'color: #aaa;');
    console.log(`%c📌 ${event.address}`, 'color: #aaa;');
    if (event.club) console.log(`%c👥 Group: ${event.club.name}`, 'color: #aaa;');
    console.log(`%c🏠 Hosted by: ${event.creator.displayName}`, 'color: #aaa;');
    console.log('');

    console.log(`%c✅ Checked In: ${checkedIn.length}`, 'color: #4caf50; font-size: 14px; font-weight: bold;');
    console.table(checkedIn.map(a => ({ Name: a.name, Status: '✅ Checked In' })));

    console.log(`%c🎟️ RSVP Only (not checked in): ${rsvpOnly.length}`, 'color: #ff9800; font-size: 14px; font-weight: bold;');
    if (rsvpOnly.length > 0) {
      console.table(rsvpOnly.map(a => ({ Name: a.name, Status: '🎟️ RSVP Only' })));
    }

    console.log('');
    console.log(`%c📊 Summary: ${event.members.totalCount} going | ${checkedIn.length} checked in | ${rsvpOnly.length} RSVP only`, 'color: #e91e63; font-size: 13px; font-weight: bold;');

    // Also return the data for further use
    return {
      event: {
        id: event.id,
        name: event.name,
        address: event.address,
        date: event.eventTime,
        endDate: event.eventEndTime,
        host: event.creator.displayName,
        group: event.club?.name,
        game: event.game,
        totalGoing: event.members.totalCount,
        checkedInCount: checkedIn.length,
        rsvpOnlyCount: rsvpOnly.length,
      },
      checkedIn: checkedIn.map(a => a.name),
      rsvpOnly: rsvpOnly.map(a => a.name),
      allMembers: members.map(m => ({
        name: m.displayName,
        status: statusMap[m.id] || 'UNKNOWN'
      }))
    };
  } catch (err) {
    console.error('Failed to fetch:', err);

    // If the query fails, try a simpler approach - just scrape the current page
    console.log('%c⚠️ GraphQL query may need updating. Trying page scrape...', 'color: yellow;');
    console.log('Tip: Open the meetup page, go to Network tab, filter "graphql",');
    console.log('find the event query, right-click → Copy as fetch, and run it here.');
  }
}

// Quick usage helper
function campfireHelp() {
  console.log(`%c🔥 Campfire Check-In Scraper`, 'color: orange; font-size: 16px; font-weight: bold;');
  console.log('');
  console.log('Usage:');
  console.log('  getCampfireAttendees("https://campfire.scopely.com/discover/meetup/YOUR-ID-HERE")');
  console.log('  getCampfireAttendees("ed2c6b61-7301-4ce4-bb0a-d15152797b8d")');
  console.log('');
  console.log('The function returns a data object you can assign:');
  console.log('  let data = await getCampfireAttendees("URL")');
  console.log('  data.checkedIn   // array of names who checked in');
  console.log('  data.rsvpOnly    // array of names who only RSVPd');
  console.log('  data.allMembers  // full list with statuses');
  console.log('');
  console.log('Export to CSV:');
  console.log('  let data = await getCampfireAttendees("URL")');
  console.log('  copy(data.allMembers.map(m => m.name + "," + m.status).join("\\n"))');
  console.log('  // Now paste into a text file or spreadsheet');
}

console.log('%c🔥 Campfire Scraper loaded!', 'color: orange; font-size: 14px; font-weight: bold;');
console.log('Type campfireHelp() for usage, or run:');
console.log('getCampfireAttendees("PASTE_MEETUP_URL_HERE")');

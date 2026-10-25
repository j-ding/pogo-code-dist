# Niantic Campfire GraphQL API Reference

## Overview

Campfire (campfire.scopely.com) is Niantic's social app for Pokemon GO community meetups. The web app is a React SPA that communicates with a GraphQL backend. This document captures the API schema and usage patterns for scraping meetup attendee/check-in data.

## Endpoint

```
POST https://niantic-social-api.nianticlabs.com/graphql
```

## Authentication

- Requires active login session on campfire.scopely.com
- Uses cookie-based auth (`credentials: 'include'` in fetch)
- Must run from the campfire.scopely.com origin (same-origin policy)

## URL Format

```
https://campfire.scopely.com/discover/meetup/{meetup-uuid}
```

Example: `https://campfire.scopely.com/discover/meetup/ed2c6b61-7301-4ce4-bb0a-d15152797b8d`

The UUID in the URL is the `eventId` used in GraphQL queries.

## GraphQL Query: GetEvent

### Operation

```graphql
query GetEvent($eventId: ID!) {
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
    isPasscodeRewardEligible
    rsvpStatus
    isSubscribed
    passcode
    coverPhotoUrl
    mapPreviewUrl
    club {
      id
      name
      game
      avatarUrl
      visibility
      amIMember
      myPermissions
      creator { id }
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
    commentsPreview {
      id
      body
      createdAt
      author {
        id
        displayName
        avatarUrl
        badges { badgeType alias }
      }
    }
    campfireLiveEvent {
      eventName
      id
      modalHeadingImageUrl
      checkInRadiusMeters
    }
    badgeGrants
    campfireLiveEventId
    hostLocationSharingSession
  }
  me {
    id
    displayName
    avatarUrl
    badges { badgeType alias }
    location
  }
}
```

### Variables

```json
{
  "eventId": "ed2c6b61-7301-4ce4-bb0a-d15152797b8d"
}
```

### Request Format

```json
{
  "operationName": "GetEvent",
  "query": "<the query above>",
  "variables": { "eventId": "<uuid>" }
}
```

## Response Schema

### Top-level

| Field | Type | Description |
|---|---|---|
| `data.event` | Object | The meetup event |
| `data.me` | Object | Currently logged-in user |

### Event Object

| Field | Type | Example | Description |
|---|---|---|---|
| `id` | String (UUID) | `"ed2c6b61-..."` | Meetup unique ID |
| `name` | String | `"Dynamax Azelf Max Battle Day [North Point Mall]"` | Event title |
| `address` | String | `"1000 North Point Circle, Alpharetta, GA, USA"` | Location address |
| `details` | String | (multiline markdown) | Full event description |
| `location` | String | `"[-84.293, 34.048]"` | `[longitude, latitude]` as string |
| `eventTime` | String (ISO8601) | `"2026-10-24T17:50:00Z"` | Event start time (UTC) |
| `eventEndTime` | String (ISO8601) | `"2026-10-24T21:40:00Z"` | Event end time (UTC) |
| `game` | String | `"PGO"` | Game identifier (Pokemon GO) |
| `visibility` | String | `"public"` | Event visibility |
| `commentCount` | Number | `8` | Total comments |
| `checkedInMembersCount` | Number | `32` | Count of checked-in attendees |
| `rsvpStatus` | String | `"CHECKED_IN"` | Current user's RSVP status |
| `isSubscribed` | Boolean | `true` | Whether current user is subscribed |
| `coverPhotoUrl` | String | URL | Event cover image |
| `mapPreviewUrl` | String | URL | Static map preview |
| `passcode` | String | `""` | Event passcode (empty if none) |
| `isPasscodeRewardEligible` | Boolean | `true` | Passcode reward eligibility |

### Members (Attendees)

```json
{
  "members": {
    "totalCount": 36,
    "edges": [
      {
        "node": {
          "id": "E:PFZ3HYZ2IRQ3BHGVAL26GO4ZZZWGIOQK4XPPJ2DCJYPYAFSPOZFQ",
          "displayName": "Beastfeetz",
          "avatarUrl": ""
        }
      }
    ]
  }
}
```

- `totalCount`: Total number of RSVPs (going)
- Each `edge.node` has `id`, `displayName`, `avatarUrl`
- User IDs are prefixed with `E:` followed by a base32-like string

### RSVP Statuses

```json
{
  "rsvpStatuses": [
    {
      "userId": "E:PFZ3HYZ2IRQ3BHGVAL26GO4ZZZWGIOQK4XPPJ2DCJYPYAFSPOZFQ",
      "rsvpStatus": "CHECKED_IN"
    },
    {
      "userId": "E:XX6ANFUXCEFYORJO263FAONHVOHOTJL7NCFXEQBW7VIYCUMXDT6Q",
      "rsvpStatus": "ACCEPTED"
    }
  ]
}
```

| Status | Meaning |
|---|---|
| `CHECKED_IN` | Physically checked in at the event location |
| `ACCEPTED` | RSVP'd "Going" but did not check in |

To correlate: match `rsvpStatuses[].userId` to `members.edges[].node.id`.

### Club (Group)

```json
{
  "club": {
    "id": "e57b2efa-2959-4060-a789-b8db2d579aa6",
    "name": "North Fulton PKGO Raids",
    "game": "PGO",
    "visibility": "public",
    "amIMember": true,
    "myPermissions": [
      "ELEVATED_CHAT", "MANAGE_CHANNELS", "MANAGE_EVENTS",
      "MODERATE_CHAT", "MANAGE_BANS", "MANAGE_ROLES", "MANAGE_CLUB"
    ]
  }
}
```

### Creator

```json
{
  "creator": {
    "id": "E:KVXQVS6VXANR2WHAL7RMAFTTDCJEHZVEBWN6P5HRXYBJ5VRJVG2Q",
    "displayName": "Ding",
    "username": "profding",
    "avatarUrl": "https://niantic-social-api.nianticlabs.com/images/8cdba46729e6c20d",
    "badges": [
      { "badgeType": "PGO_COMMUNITY_AMBASSADOR", "alias": "PGO_COMMUNITY_AMBASSADOR" }
    ]
  }
}
```

### Badge Types

| Badge | Description |
|---|---|
| `PGO_COMMUNITY_AMBASSADOR` | Pokemon GO Community Ambassador |

### Comments Preview

```json
{
  "commentsPreview": [
    {
      "id": "129ac609-...",
      "body": "jonathan and tony said they'd do one with me. near Auntie Anne's",
      "createdAt": "2026-10-24T20:34:04.922Z",
      "author": {
        "id": "E:...",
        "displayName": "gigantaninja",
        "avatarUrl": "",
        "badges": null
      }
    }
  ]
}
```

### Campfire Live Event

```json
{
  "campfireLiveEvent": {
    "eventName": "Dynamax Uxie, Mesprit, and Azelf Max Battle Day",
    "id": "f9858086-c66d-4db4-8755-28046ea6f36d",
    "modalHeadingImageUrl": "https://social.nianticlabs.com/images/discover/...",
    "checkInRadiusMeters": null
  }
}
```

This links the local meetup to a global Niantic event.

### Me (Current User)

```json
{
  "me": {
    "id": "E:KVXQVS6VXANR2WHAL7RMAFTTDCJEHZVEBWN6P5HRXYBJ5VRJVG2Q",
    "displayName": "Ding",
    "avatarUrl": "https://niantic-social-api.nianticlabs.com/images/8cdba46729e6c20d",
    "badges": [{ "badgeType": "PGO_COMMUNITY_AMBASSADOR", "alias": "PGO_COMMUNITY_AMBASSADOR" }],
    "location": ""
  }
}
```

## Sample Data: Azelf Max Battle Day (Oct 24 2026)

**Event**: Dynamax Azelf Max Battle Day [North Point Mall]
**Group**: North Fulton PKGO Raids
**Host**: Ding (profding)
**Location**: 1000 North Point Circle, Alpharetta, GA
**Time**: 1:50 PM - 5:40 PM ET (Oct 24, 2026)
**Total Going**: 36
**Checked In**: 32
**RSVP Only (no check-in)**: 4

### Checked In (32)

| # | Display Name |
|---|---|
| 1 | Beastfeetz |
| 2 | SeannibalOK |
| 3 | jlaplant |
| 4 | Flav |
| 5 | Ding |
| 6 | naydrascale |
| 7 | gayllade |
| 8 | gigantaninja |
| 9 | Nelleejellee |
| 10 | Mouxxii |
| 11 | humblehsu |
| 12 | ToadRowSprocket |
| 13 | jamlut |
| 14 | disdawgs |
| 15 | Pokemaster9359 |
| 16 | nygiants2ooo |
| 17 | Liminade |
| 18 | gymleaderding |
| 19 | Alexander963 |
| 20 | jiejie9195 |
| 21 | dragonslayer28 |
| 22 | sarahsnickna192 |
| 23 | allergic2dairy |
| 24 | RamblinMan2335 |
| 25 | radepicsmasher |
| 26 | JockeyLP8 |
| 27 | yashwanth3933 |
| 28 | GandalfTheWight |
| 29 | choritzo14 |
| 30 | generikon |
| 31 | EliteFourDing |
| 32 | Mockinbirdo |

### RSVP Only - Did NOT Check In (4)

| # | Display Name |
|---|---|
| 1 | mnicho4 |
| 2 | venmad |
| 3 | TheAntho2025 |
| 4 | YNTCD022022 |

## Console Snippet: Quick Analysis

Paste this after the scraper script to analyze any fetched event data:

```javascript
// After: let data = await getCampfireAttendees("URL")
console.table(data.allMembers);                    // Full table
console.log("Checked in:", data.checkedIn);         // Names array
console.log("RSVP only:", data.rsvpOnly);           // Names array
console.log(`${data.event.checkedInCount}/${data.event.totalGoing} checked in`);

// Export to CSV
copy("Name,Status\n" + data.allMembers.map(m => m.name + "," + m.status).join("\n"));
```

## Notes

- The GraphQL endpoint also handles `trackClientAction` mutations (analytics/telemetry) — these are noise when looking for event data
- The page makes ~27+ GraphQL calls on load; only the `GetEvent` query returns useful meetup data
- `commentsPermissions: "ALL_INVITED"` means all RSVPd members can comment
- The `location` field is `[longitude, latitude]` as a JSON string (note: lon first, then lat)
- `myPermissions` on the club object shows what the logged-in user can do in the group
- Avatar URLs use `niantic-social-api.nianticlabs.com/images/{hash}` — some users have empty avatars

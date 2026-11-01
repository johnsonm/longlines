// Real payloads from the seeded local stack (supabase/seed.sql), captured whole for the
// function's tests (supabase/functions/_shared/__tests__/fixtures/spotted-activations.json) and
// copied here, so the web is tested against what SQL actually builds.

import type { CallsignActivations, SpottedActivation } from "./types.ts";

/** KK4PWJ's seeded week: a two-fer, a rover day ending in a single spot, a midnight split. */
export const LIST: CallsignActivations = {
  "more": false,
  "recent": [
    {
      "id": "bt2bjhxdrues",
      "day": "2026-10-31",
      "bands": [
        "20m",
        "30m"
      ],
      "modes": [
        "cw"
      ],
      "states": 2,
      "program": "pota",
      "countries": 0,
      "spotCount": 3,
      "startedAt": "2026-10-31T16:05:00Z",
      "lastSpotAt": "2026-10-31T16:44:00Z",
      "references": [
        "US-1871"
      ],
      "continuedBy": null,
      "continuedFrom": null,
      "referenceNames": [
        "Willow Hollow Wildlife Management Area"
      ],
      "durationSeconds": 2340
    },
    {
      "id": "grw3jgwakszn",
      "day": "2026-10-30",
      "bands": [
        "40m",
        "80m"
      ],
      "modes": [
        "ssb"
      ],
      "states": 3,
      "program": "pota",
      "countries": 0,
      "spotCount": 3,
      "startedAt": "2026-10-30T00:06:00Z",
      "lastSpotAt": "2026-10-30T00:38:00Z",
      "references": [
        "US-1182"
      ],
      "continuedBy": null,
      "continuedFrom": "n7h4dcckfp3d",
      "referenceNames": [
        "Juniper Ridge Wildlife Management Area"
      ],
      "durationSeconds": 1920
    },
    {
      "id": "n7h4dcckfp3d",
      "day": "2026-10-29",
      "bands": [
        "40m"
      ],
      "modes": [
        "ssb"
      ],
      "states": 2,
      "program": "pota",
      "countries": 0,
      "spotCount": 3,
      "startedAt": "2026-10-29T23:20:00Z",
      "lastSpotAt": "2026-10-29T23:52:00Z",
      "references": [
        "US-1182"
      ],
      "continuedBy": "grw3jgwakszn",
      "continuedFrom": null,
      "referenceNames": [
        "Juniper Ridge Wildlife Management Area"
      ],
      "durationSeconds": 1920
    },
    {
      "id": "e523ohndad6g",
      "day": "2026-10-28",
      "bands": [
        "20m"
      ],
      "modes": [
        "cw"
      ],
      "states": 1,
      "program": "pota",
      "countries": 0,
      "spotCount": 1,
      "startedAt": "2026-10-28T17:20:00Z",
      "lastSpotAt": "2026-10-28T17:20:00Z",
      "references": [
        "US-2274"
      ],
      "continuedBy": null,
      "continuedFrom": null,
      "referenceNames": [
        "Crystal Point State Park"
      ],
      "durationSeconds": 0
    },
    {
      "id": "6iiz2lvvuepe",
      "day": "2026-10-28",
      "bands": [
        "20m"
      ],
      "modes": [
        "ssb"
      ],
      "states": 2,
      "program": "pota",
      "countries": 0,
      "spotCount": 3,
      "startedAt": "2026-10-28T15:30:00Z",
      "lastSpotAt": "2026-10-28T16:10:00Z",
      "references": [
        "US-2144"
      ],
      "continuedBy": null,
      "continuedFrom": null,
      "referenceNames": [
        "Hawk Point National Wildlife Refuge"
      ],
      "durationSeconds": 2400
    },
    {
      "id": "qk7bn4itoxqh",
      "day": "2026-10-28",
      "bands": [
        "20m",
        "40m"
      ],
      "modes": [
        "cw",
        "ssb"
      ],
      "states": 3,
      "program": "pota",
      "countries": 1,
      "spotCount": 6,
      "startedAt": "2026-10-28T14:00:00Z",
      "lastSpotAt": "2026-10-28T14:40:00Z",
      "references": [
        "US-1936"
      ],
      "continuedBy": null,
      "continuedFrom": null,
      "referenceNames": [
        "Heron Hollow State Forest"
      ],
      "durationSeconds": 2400
    },
    {
      "id": "kjw2khkyj47f",
      "day": "2026-10-26",
      "bands": [
        "20m",
        "40m"
      ],
      "modes": [
        "ssb",
        "cw"
      ],
      "states": 5,
      "program": "pota",
      "countries": 2,
      "spotCount": 11,
      "startedAt": "2026-10-26T18:12:00Z",
      "lastSpotAt": "2026-10-26T19:40:00Z",
      "references": [
        "US-1182",
        "US-1871"
      ],
      "continuedBy": null,
      "continuedFrom": null,
      "referenceNames": [
        "Juniper Ridge Wildlife Management Area",
        "Willow Hollow Wildlife Management Area"
      ],
      "durationSeconds": 5280
    }
  ],
  "summary": {
    "references": {
      "iota": 0,
      "pota": 5,
      "sota": 0,
      "wwff": 0,
      "total": 5,
      "wwbota": 0
    },
    "activations": 7,
    "onAirSeconds": 16260,
    "mostActivated": {
      "name": "Juniper Ridge Wildlife Management Area",
      "times": 3,
      "program": "pota",
      "reference": "US-1182"
    }
  },
  "callsign": "KK4PWJ"
};

/** A call never spotted activating. */
export const EMPTY_LIST: CallsignActivations = {
  "more": false,
  "recent": [],
  "summary": {
    "references": {
      "iota": 0,
      "pota": 0,
      "sota": 0,
      "wwff": 0,
      "total": 0,
      "wwbota": 0
    },
    "activations": 0,
    "onAirSeconds": 0,
    "mostActivated": null
  },
  "callsign": "W1AW"
};

export const TWOFER: SpottedActivation = {
  "id": "kjw2khkyj47f",
  "day": "2026-10-26",
  "bands": [
    "20m",
    "40m"
  ],
  "heard": [
    {
      "code": "MA",
      "kind": "state",
      "name": "Massachusetts",
      "spots": 2,
      "latitude": 42.2543,
      "longitude": -71.7924
    },
    {
      "code": "PA",
      "kind": "state",
      "name": "Pennsylvania",
      "spots": 2,
      "latitude": 40.8783,
      "longitude": -77.8001
    },
    {
      "code": "NY",
      "kind": "state",
      "name": "New York",
      "spots": 1,
      "latitude": 42.9366,
      "longitude": -75.5074
    },
    {
      "code": "NC",
      "kind": "state",
      "name": "North Carolina",
      "spots": 1,
      "latitude": 35.5522,
      "longitude": -79.3559
    },
    {
      "code": "VA",
      "kind": "state",
      "name": "Virginia",
      "spots": 1,
      "latitude": 37.5213,
      "longitude": -78.8184
    },
    {
      "code": "DL",
      "kind": "country",
      "name": "Fed. Rep. of Germany",
      "spots": 2,
      "latitude": 51.0,
      "longitude": 10.0
    },
    {
      "code": "VE",
      "kind": "country",
      "name": "Canada",
      "spots": 1,
      "latitude": 44.35,
      "longitude": -78.75
    }
  ],
  "modes": [
    "ssb",
    "cw"
  ],
  "split": {
    "continuedBy": null,
    "continuedFrom": null
  },
  "spots": [
    {
      "mode": "ssb",
      "time": "2026-10-26T18:12:00Z",
      "place": "United States",
      "source": "pota",
      "spotter": "KK4PWJ",
      "selfSpot": true,
      "references": [
        "US-1182"
      ],
      "spotterBase": "KK4PWJ",
      "frequencyKhz": 14239.1
    },
    {
      "mode": "ssb",
      "time": "2026-10-26T18:13:00Z",
      "place": "North Carolina",
      "source": "pota",
      "spotter": "N4KJS",
      "selfSpot": false,
      "references": [
        "US-1871"
      ],
      "spotterBase": "N4KJS",
      "frequencyKhz": 14273.1
    },
    {
      "mode": "ssb",
      "time": "2026-10-26T18:25:00Z",
      "place": "Virginia",
      "source": "pota",
      "spotter": "W4DAS",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "W4DAS",
      "frequencyKhz": 14258.8
    },
    {
      "mode": "ssb",
      "time": "2026-10-26T18:30:00Z",
      "place": "New York",
      "source": "dxcluster",
      "spotter": "W2NYS",
      "selfSpot": false,
      "references": null,
      "spotterBase": "W2NYS",
      "frequencyKhz": 14285.0
    },
    {
      "mode": "cw",
      "time": "2026-10-26T18:41:00Z",
      "place": "Pennsylvania",
      "source": "pota",
      "spotter": "K3ZRS",
      "selfSpot": false,
      "references": [
        "US-1871"
      ],
      "spotterBase": "K3ZRS",
      "frequencyKhz": 7017.3
    },
    {
      "mode": "cw",
      "time": "2026-10-26T18:45:00Z",
      "place": "Pennsylvania",
      "source": "rbn",
      "spotter": "K3ZRS-#",
      "selfSpot": false,
      "references": null,
      "spotterBase": "K3ZRS",
      "frequencyKhz": 7031.5
    },
    {
      "mode": "cw",
      "time": "2026-10-26T18:46:00Z",
      "place": "Massachusetts",
      "source": "rbn",
      "spotter": "W1QTS-#",
      "selfSpot": false,
      "references": null,
      "spotterBase": "W1QTS",
      "frequencyKhz": 7031.5
    },
    {
      "mode": "cw",
      "time": "2026-10-26T18:52:00Z",
      "place": "Fed. Rep. of Germany",
      "source": "rbn",
      "spotter": "DL1DES-#",
      "selfSpot": false,
      "references": null,
      "spotterBase": "DL1DES",
      "frequencyKhz": 7031.6
    },
    {
      "mode": "cw",
      "time": "2026-10-26T18:58:00Z",
      "place": "Massachusetts",
      "source": "pota",
      "spotter": "W1QTS",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "W1QTS",
      "frequencyKhz": 7022.8
    },
    {
      "mode": "ssb",
      "time": "2026-10-26T19:15:00Z",
      "place": "Canada",
      "source": "pota",
      "spotter": "VE3ONS",
      "selfSpot": false,
      "references": [
        "US-1871"
      ],
      "spotterBase": "VE3ONS",
      "frequencyKhz": 14244.8
    },
    {
      "mode": "ssb",
      "time": "2026-10-26T19:40:00Z",
      "place": "Fed. Rep. of Germany",
      "source": "pota",
      "spotter": "DL1DES",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "DL1DES",
      "frequencyKhz": 14238.8
    }
  ],
  "program": "pota",
  "sources": {
    "rbn": 3,
    "pota": 7,
    "dxcluster": 1
  },
  "callsign": "KK4PWJ",
  "farthest": {
    "km": 6995,
    "code": "DL",
    "kind": "country",
    "name": "Fed. Rep. of Germany"
  },
  "location": {
    "states": [
      "NC"
    ],
    "latitude": 35.67,
    "longitude": -79.75
  },
  "spotCount": 11,
  "startedAt": "2026-10-26T18:12:00Z",
  "lastSpotAt": "2026-10-26T19:40:00Z",
  "references": [
    "US-1182",
    "US-1871"
  ],
  "referenceNames": [
    "Juniper Ridge Wildlife Management Area",
    "Willow Hollow Wildlife Management Area"
  ],
  "durationSeconds": 5280
};

export const SPLIT: SpottedActivation = {
  "id": "grw3jgwakszn",
  "day": "2026-10-30",
  "bands": [
    "40m",
    "80m"
  ],
  "heard": [
    {
      "code": "GA",
      "kind": "state",
      "name": "Georgia",
      "spots": 1,
      "latitude": 32.6378,
      "longitude": -83.4359
    },
    {
      "code": "MI",
      "kind": "state",
      "name": "Michigan",
      "spots": 1,
      "latitude": 44.3204,
      "longitude": -85.3778
    },
    {
      "code": "NC",
      "kind": "state",
      "name": "North Carolina",
      "spots": 1,
      "latitude": 35.5522,
      "longitude": -79.3559
    }
  ],
  "modes": [
    "ssb"
  ],
  "split": {
    "continuedBy": null,
    "continuedFrom": "n7h4dcckfp3d"
  },
  "spots": [
    {
      "mode": "ssb",
      "time": "2026-10-30T00:06:00Z",
      "place": "Georgia",
      "source": "pota",
      "spotter": "K4GAS",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "K4GAS",
      "frequencyKhz": 7186.5
    },
    {
      "mode": "ssb",
      "time": "2026-10-30T00:21:00Z",
      "place": "Michigan",
      "source": "pota",
      "spotter": "N8MIS",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "N8MIS",
      "frequencyKhz": 7232.0
    },
    {
      "mode": "ssb",
      "time": "2026-10-30T00:38:00Z",
      "place": "North Carolina",
      "source": "pota",
      "spotter": "N4KJS",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "N4KJS",
      "frequencyKhz": 3819.0
    }
  ],
  "program": "pota",
  "sources": {
    "pota": 3
  },
  "callsign": "KK4PWJ",
  "farthest": {
    "km": 1074,
    "code": "MI",
    "kind": "state",
    "name": "Michigan"
  },
  "location": {
    "states": [
      "NC"
    ],
    "latitude": 35.67,
    "longitude": -79.75
  },
  "spotCount": 3,
  "startedAt": "2026-10-30T00:06:00Z",
  "lastSpotAt": "2026-10-30T00:38:00Z",
  "references": [
    "US-1182"
  ],
  "referenceNames": [
    "Juniper Ridge Wildlife Management Area"
  ],
  "durationSeconds": 1920
};

export const CONTINUED: SpottedActivation = {
  "id": "n7h4dcckfp3d",
  "day": "2026-10-29",
  "bands": [
    "40m"
  ],
  "heard": [
    {
      "code": "AK",
      "kind": "state",
      "name": "Alaska",
      "spots": 1,
      "latitude": 63.9244,
      "longitude": -152.3794
    },
    {
      "code": "NY",
      "kind": "state",
      "name": "New York",
      "spots": 1,
      "latitude": 42.9366,
      "longitude": -75.5074
    }
  ],
  "modes": [
    "ssb"
  ],
  "split": {
    "continuedBy": "grw3jgwakszn",
    "continuedFrom": null
  },
  "spots": [
    {
      "mode": "ssb",
      "time": "2026-10-29T23:20:00Z",
      "place": "United States",
      "source": "pota",
      "spotter": "KK4PWJ",
      "selfSpot": true,
      "references": [
        "US-1182"
      ],
      "spotterBase": "KK4PWJ",
      "frequencyKhz": 7223.1
    },
    {
      "mode": "ssb",
      "time": "2026-10-29T23:35:00Z",
      "place": "Alaska",
      "source": "pota",
      "spotter": "KL7AKS",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "KL7AKS",
      "frequencyKhz": 7190.0
    },
    {
      "mode": "ssb",
      "time": "2026-10-29T23:52:00Z",
      "place": "New York",
      "source": "pota",
      "spotter": "W2NYS",
      "selfSpot": false,
      "references": [
        "US-1182"
      ],
      "spotterBase": "W2NYS",
      "frequencyKhz": 7183.8
    }
  ],
  "program": "pota",
  "sources": {
    "pota": 3
  },
  "callsign": "KK4PWJ",
  "farthest": {
    "km": 5662,
    "code": "AK",
    "kind": "state",
    "name": "Alaska"
  },
  "location": {
    "states": [
      "NC"
    ],
    "latitude": 35.67,
    "longitude": -79.75
  },
  "spotCount": 3,
  "startedAt": "2026-10-29T23:20:00Z",
  "lastSpotAt": "2026-10-29T23:52:00Z",
  "references": [
    "US-1182"
  ],
  "referenceNames": [
    "Juniper Ridge Wildlife Management Area"
  ],
  "durationSeconds": 1920
};

export const SINGLE: SpottedActivation = {
  "id": "e523ohndad6g",
  "day": "2026-10-28",
  "bands": [
    "20m"
  ],
  "heard": [
    {
      "code": "IL",
      "kind": "state",
      "name": "Illinois",
      "spots": 1,
      "latitude": 40.0421,
      "longitude": -89.1969
    }
  ],
  "modes": [
    "cw"
  ],
  "split": {
    "continuedBy": null,
    "continuedFrom": null
  },
  "spots": [
    {
      "mode": "cw",
      "time": "2026-10-28T17:20:00Z",
      "place": "Illinois",
      "source": "pota",
      "spotter": "K9ILS",
      "selfSpot": false,
      "references": [
        "US-2274"
      ],
      "spotterBase": "K9ILS",
      "frequencyKhz": 14022.7
    }
  ],
  "program": "pota",
  "sources": {
    "pota": 1
  },
  "callsign": "KK4PWJ",
  "farthest": {
    "km": 1042,
    "code": "IL",
    "kind": "state",
    "name": "Illinois"
  },
  "location": {
    "states": [
      "NC"
    ],
    "latitude": 36.15,
    "longitude": -78.35
  },
  "spotCount": 1,
  "startedAt": "2026-10-28T17:20:00Z",
  "lastSpotAt": "2026-10-28T17:20:00Z",
  "references": [
    "US-2274"
  ],
  "referenceNames": [
    "Crystal Point State Park"
  ],
  "durationSeconds": 0
};

export const IOTA: SpottedActivation = {
  "id": "ge7t7iccnvgb",
  "day": "2026-10-25",
  "bands": [
    "40m"
  ],
  "heard": [],
  "modes": [
    "cw"
  ],
  "split": {
    "continuedBy": null,
    "continuedFrom": null
  },
  "spots": [
    {
      "mode": "cw",
      "time": "2026-10-25T09:01:37Z",
      "place": "United States",
      "source": "dxcluster",
      "spotter": "K6AELS",
      "selfSpot": false,
      "references": [
        "EU-115"
      ],
      "spotterBase": "K6AELS",
      "frequencyKhz": 7045.1
    }
  ],
  "program": "iota",
  "sources": {
    "dxcluster": 1
  },
  "callsign": "K44ABCS",
  "farthest": null,
  "location": null,
  "spotCount": 1,
  "startedAt": "2026-10-25T09:01:37Z",
  "lastSpotAt": "2026-10-25T09:01:37Z",
  "references": [
    "EU-115"
  ],
  "referenceNames": [
    "Ireland"
  ],
  "durationSeconds": 0
};

export const WWBOTA: SpottedActivation = {
  "id": "ct2wi2kawhx7",
  "day": "2026-10-25",
  "bands": [
    "40m"
  ],
  "heard": [],
  "modes": [
    "ssb"
  ],
  "split": {
    "continuedBy": null,
    "continuedFrom": null
  },
  "spots": [
    {
      "mode": "ssb",
      "time": "2026-10-25T11:09:59Z",
      "place": null,
      "source": "wwbota",
      "spotter": "ON1AAKS/P",
      "selfSpot": true,
      "references": [
        "B/ON-0478",
        "B/ON-0479",
        "B/ON-0480"
      ],
      "spotterBase": "ON1AAKS",
      "frequencyKhz": 7237.7
    },
    {
      "mode": "ssb",
      "time": "2026-10-25T11:18:19Z",
      "place": null,
      "source": "wwbota",
      "spotter": "ON0AABS",
      "selfSpot": false,
      "references": [
        "B/ON-0478",
        "B/ON-0479",
        "B/ON-0480"
      ],
      "spotterBase": "ON0AABS",
      "frequencyKhz": 7221.8
    }
  ],
  "program": "wwbota",
  "sources": {
    "wwbota": 2
  },
  "callsign": "ON1AAKS",
  "farthest": null,
  "location": null,
  "spotCount": 2,
  "startedAt": "2026-10-25T11:09:59Z",
  "lastSpotAt": "2026-10-25T11:18:19Z",
  "references": [
    "B/ON-0478",
    "B/ON-0479",
    "B/ON-0480"
  ],
  "referenceNames": [
    "Seed ROC Post",
    null,
    null
  ],
  "durationSeconds": 500
};

export const COUNTRIES: SpottedActivation = {
  "id": "2qir2bsqhckb",
  "day": "2026-10-30",
  "bands": [
    "80m",
    "40m",
    "60m"
  ],
  "heard": [
    {
      "code": "VE",
      "kind": "country",
      "name": "Canada",
      "spots": 1,
      "latitude": 44.35,
      "longitude": -78.75
    },
    {
      "code": "JA",
      "kind": "country",
      "name": "Japan",
      "spots": 1,
      "latitude": 36.4,
      "longitude": 138.38
    }
  ],
  "modes": [
    "cw"
  ],
  "split": {
    "continuedBy": null,
    "continuedFrom": null
  },
  "spots": [
    {
      "mode": "cw",
      "time": "2026-10-30T11:02:58Z",
      "place": "United States",
      "source": "wwff",
      "spotter": "K0AAAS",
      "selfSpot": true,
      "references": [
        "KFF-2495"
      ],
      "spotterBase": "K0AAAS",
      "frequencyKhz": 3514.2
    },
    {
      "mode": "cw",
      "time": "2026-10-30T11:08:24Z",
      "place": "United States",
      "source": "rbn",
      "spotter": "K0AICS",
      "selfSpot": false,
      "references": null,
      "spotterBase": "K0AICS",
      "frequencyKhz": 3536.7
    },
    {
      "mode": "cw",
      "time": "2026-10-30T11:10:25Z",
      "place": "Canada",
      "source": "wwff",
      "spotter": "VA1AIPS",
      "selfSpot": false,
      "references": [
        "KFF-2495"
      ],
      "spotterBase": "VA1AIPS",
      "frequencyKhz": 7042.8
    },
    {
      "mode": "cw",
      "time": "2026-10-30T11:13:18Z",
      "place": "Japan",
      "source": "rbn",
      "spotter": "JA0AAFS",
      "selfSpot": false,
      "references": null,
      "spotterBase": "JA0AAFS",
      "frequencyKhz": 7013.0
    },
    {
      "mode": "cw",
      "time": "2026-10-30T11:14:12Z",
      "place": "United States",
      "source": "wwff",
      "spotter": "KJ5AEFS",
      "selfSpot": false,
      "references": [
        "KFF-2495"
      ],
      "spotterBase": "KJ5AEFS",
      "frequencyKhz": 5362.2
    }
  ],
  "program": "wwff",
  "sources": {
    "rbn": 2,
    "wwff": 3
  },
  "callsign": "K0AAAS",
  "farthest": {
    "km": 10420,
    "code": "JA",
    "kind": "country",
    "name": "Japan"
  },
  "location": {
    "states": [],
    "latitude": 31.0,
    "longitude": -99.15
  },
  "spotCount": 5,
  "startedAt": "2026-10-30T11:02:58Z",
  "lastSpotAt": "2026-10-30T11:14:12Z",
  "references": [
    "KFF-2495"
  ],
  "referenceNames": [
    "Bluff River Wildlife Management Area"
  ],
  "durationSeconds": 674
};

export const NULL_SPOTTER: SpottedActivation = {
  "id": "x6szykr5qsjc",
  "day": "2026-10-25",
  "bands": [
    "2m"
  ],
  "heard": [
    {
      "code": "G",
      "kind": "country",
      "name": "England",
      "spots": 3,
      "latitude": 52.77,
      "longitude": -1.47
    }
  ],
  "modes": [
    "fm"
  ],
  "split": {
    "continuedBy": null,
    "continuedFrom": null
  },
  "spots": [
    {
      "mode": "fm",
      "time": "2026-10-25T14:22:44Z",
      "place": "United States",
      "source": "sotawatch",
      "spotter": "W5AEBS",
      "selfSpot": true,
      "references": [
        "SP/SS-118"
      ],
      "spotterBase": "W5AEBS",
      "frequencyKhz": 146520.0
    },
    {
      "mode": "fm",
      "time": "2026-10-25T14:28:53Z",
      "place": "England",
      "source": "sotawatch",
      "spotter": "M0AIDS",
      "selfSpot": false,
      "references": [
        "SP/SS-118"
      ],
      "spotterBase": "M0AIDS",
      "frequencyKhz": 146520.0
    },
    {
      "mode": "fm",
      "time": "2026-10-25T14:34:36Z",
      "place": "England",
      "source": "sotawatch",
      "spotter": "G2ADMS",
      "selfSpot": false,
      "references": [
        "SP/SS-118"
      ],
      "spotterBase": "G2ADMS",
      "frequencyKhz": 146520.0
    },
    {
      "mode": "fm",
      "time": "2026-10-25T14:40:57Z",
      "place": null,
      "source": "sotawatch",
      "spotter": null,
      "selfSpot": false,
      "references": [
        "SP/SS-118"
      ],
      "spotterBase": null,
      "frequencyKhz": 146520.0
    },
    {
      "mode": "fm",
      "time": "2026-10-25T14:48:18Z",
      "place": "England",
      "source": "sotawatch",
      "spotter": "M0AQFS",
      "selfSpot": false,
      "references": [
        "SP/SS-118"
      ],
      "spotterBase": "M0AQFS",
      "frequencyKhz": 146520.0
    }
  ],
  "program": "sota",
  "sources": {
    "sotawatch": 5
  },
  "callsign": "W5AEBS",
  "farthest": {
    "km": 10988,
    "code": "G",
    "kind": "country",
    "name": "England"
  },
  "location": {
    "states": [],
    "latitude": -37.2,
    "longitude": 45.61
  },
  "spotCount": 5,
  "startedAt": "2026-10-25T14:22:44Z",
  "lastSpotAt": "2026-10-25T14:48:18Z",
  "references": [
    "SP/SS-118"
  ],
  "referenceNames": [
    "Seed Peak 118"
  ],
  "durationSeconds": 1534
};

# Catalogue classification review

Generated from a cached metadata snapshot on 2026-09-25. No external API calls. Supplier categories, stock, prices, hidden flags and SKU successions remain unchanged. Existing Renogy storefront scope is retained.

971 storefront products reviewed; 220 category changes; 73 products with numeric cable measurements; 18 products retained for review.

## Review outcome

Reviewed before rollout against all 971 non-hidden products in the existing storefront scope (1,034 cached records overall). Accepted 220 customer-facing category changes and 73 products with numeric cable measurements. All 47 confidently identified individual panel products have a power attribute. The five existing 450 V RS SKU matches are preserved, including the separately saleable MPPT predecessor.

Corrections made during review: battery monitors remain in their original group; mounting adapters, antenna kits/leads and solar-panel connectors are not mislabelled as cables or panels; BMS equipment does not inherit battery ratings; RJ45 splitter lead length is parsed separately from its connector counts. The length/conductor report below was checked against the stored names. Unsupported feet/AWG values remain unset rather than converted speculatively.

Eighteen entries retain their existing supplier grouping for later review: 13 transformer/isolator products without a supported filter profile, two ambiguous TMB Series names, one solar suitcase whose bundle contents are unclear, one NMEA2000 connection with no explicit sold-item type, and SolarSense 750. No manual classification overrides were needed for this rollout. The reason-backed override mechanism is covered by a sync-persistence regression test.

## Category changes

Change | Products
--- | ---
solar_panel → Other accessories | 6
solar_panel → Solar panels | 17
solar_panel → Cables & connectors | 5
Batteries → Cables & connectors | 6
Batteries → Other accessories | 2
Battery Isolators → Other accessories | 1
Battery monitors and SmartShunt → Other accessories | 1
Blue Power Chargers → Cables & connectors | 11
Blue Power Chargers → Other accessories | 10
DC-DC Converters → Other accessories | 1
DC-DC Converters → Cables & connectors | 1
Electrical → Other accessories | 5
High power chargers → Cables & connectors | 2
Miscellaneous → Cables & connectors | 78
Remote panels & monitoring → Other accessories | 19
Remote panels & monitoring → Cables & connectors | 3
Solar chargers → Cables & connectors | 1
Solar chargers → Other accessories | 9
Solar panels and cables → Solar panels | 30
Solar panels and cables → Cables & connectors | 12

## All reclassified products

SKU | Name | Supplier category / subcategory | Display category | Product type
--- | --- | --- | --- | ---
RNG-KIT-STARTER100D-WND30-G3-SA | 100W 12V Monocrystalline Solar Starter Kit w/Wanderer 30A Charge Controller | solar_panel / - | Other accessories | Kit
RNG-100DB-H-G4-SA | 100 Watt 12 Volt Flexible Monocrystalline Solar Panel | solar_panel / - | Solar panels | Solar panel
RSP100DL-36-G2-SA | 100W flexible Monocrystalline black Solar Panel | solar_panel / - | Solar panels | Solar panel
RNG-100D-SS-G3-SA | 100W Rigid Solar Panel | solar_panel / - | Solar panels | Solar panel
RNG-100D-SSx2-G3-SA | 100W Rigid Solar Panel (2 pcs) | solar_panel / - | Solar panels | Solar panel
RPP30EF-LN-G1-SA | 30W Portable solar panel | solar_panel / - | Solar panels | Solar panel
RMT550BB-G1-SA | Adjustable Balcony Bracket | solar_panel / - | Other accessories | Mounting / protection
RSP200DB-72-G2-SA | CORE 12V 200W Lightweight and Flexible Solar Panel | solar_panel / - | Solar panels | Solar panel
RSP200D-G3-SA | CORE 12V 200W Rigid Solar Panel | solar_panel / - | Solar panels | Solar panel
RNG-50D-SS-G3-SA | CORE 12V 50W Monocrystalline Solar Panel | solar_panel / - | Solar panels | Solar panel
RPP200EF-SE-G2-SA | CORE 200W Portable solar panel | solar_panel / - | Solar panels | Solar panel
RNG-CNCT-FUSE20-G1-SA | CORE 20A MC4 Waterproof in-Line Fuse Holder w/Fuse | solar_panel / - | Other accessories | Other accessory
RNG-50DB-H-G3-SA | CORE 50W Monocrystalline Flexible Solar Panel | solar_panel / - | Solar panels | Solar panel
RNG-CNCT-MC4Y-M-G1-SA | CORE Solar MC4Y2 Branch Connectors MMMF+FFFM Pair, Multicolor | solar_panel / - | Cables & connectors | Connector
RNG-AK-20FT-10-G1-SA | CORE Solar Panel to Charge Controller Adaptor Kit 20 Ft 10 AWG | solar_panel / - | Cables & connectors | Adapter
RSP100LSC-G1-SA | Renogy 100W Lightweight N-type Portable Solar Panel Suitcase | solar_panel / - | Solar panels | Solar panel
RPP100EF-SE-G2-SA | Renogy 100W Portable Solar Panel | solar_panel / - | Solar panels | Solar panel
RPP200SB-SE-G1-SA | Renogy 200W Lightweight N-type Portable Solar Panel Blanket | solar_panel / - | Solar panels | Solar panel
RSP300LSC-G1-SA | Renogy 300W Lightweight N-type Portable Solar Panel Suitcase | solar_panel / - | Solar panels | Solar panel
RSP400SB-G3-SA | Renogy 400W Lightweight N-type Portable Solar Panel Blanket | solar_panel / - | Solar panels | Solar panel
RSP400LSC-G1-SA | Renogy 400W Lightweight Portable Mono Solar Panel Suitcase | solar_panel / - | Solar panels | Solar panel
RNG-CNCT-MC4x5-G1-SA | Renogy 5 Pair MC4 Male/Female Solar Panel Cable Connectors Double Seal Rings for Better Waterproof Effect | solar_panel / - | Cables & connectors | Connector
RNG-MTS-TM100-G1-SA | RENOGY Adjustable Solar Panel Roof Tilt Mount | solar_panel / - | Other accessories | Mounting / protection
RNG-CNCT-MC4Y-G2-SA | Renogy CNCT-MC4Y Branch Connectors Solar MC4 Connectors Y Connector in Pair MMF+FFM | solar_panel / - | Cables & connectors | Connector
RNG-MTS-CB-G1-SA | Renogy Corner Bracket Mount | solar_panel / - | Other accessories | Mounting / protection
REC10FT10PR-G1-SA | Renogy MC4 Solar Extension Cable -10ft 10AWG Pair | solar_panel / - | Cables & connectors | Cable
RNG-MTS-ZB-G1-SA | Renogy RNG-MTS-ZB Solar Panel Mounting Z Bracket Mount Supporting for RV, Roof, Boat, Set of 4 Units | solar_panel / - | Other accessories | Mounting / protection
RSP200DC-ASR-G1-SA | Renogy ShadowFlux 200W N-Type Anti-Shading Solar Panel | solar_panel / - | Solar panels | Solar panel
ASS070200100 | Cable for Smart BMS CL 12-100 to MultiPlus | Batteries / Battery Management Systems (BMS) | Cables & connectors | Cable
ASS032300010 | Lithium NG Service Tool USB-A | Batteries / Battery Management Systems (BMS) | Other accessories | Service tool
ASS032300030 | Lithium NG Service Tool USB-C | Batteries / Battery Management Systems (BMS) | Other accessories | Service tool
ASS030560100 | M8 circular connector Male/Female 3 pole cable 1m (bag of 2) | Batteries / Battery Management Systems (BMS) | Cables & connectors | Cable
ASS030560200 | M8 circular connector Male/Female 3 pole cable 2m (bag of 2) | Batteries / Battery Management Systems (BMS) | Cables & connectors | Cable
ASS030560300 | M8 circular connector Male/Female 3 pole cable 3m (bag of 2) | Batteries / Battery Management Systems (BMS) | Cables & connectors | Cable
ASS030560500 | M8 circular connector Male/Female 3 pole cable 5m (bag of 2) | Batteries / Battery Management Systems (BMS) | Cables & connectors | Cable
ASS030510120 | VE.Bus BMS to BMS 12-200 alternator control cable | Batteries / Battery Management Systems (BMS) | Cables & connectors | Cable
CYR010120110R | Cyrix-ct 12/24V-120A Battery Combiner Kit Retail | Battery Isolators / Microprocessor controlled battery combiner/isolators | Other accessories | Kit
ASS000100000 | Temperature sensor for BMV-702/712 | Battery monitors and SmartShunt / Battery Monitors & Accessories | Other accessories | Sensor
BPC900300014 | 12 Volt plug (cigarette plug with 16A fuse) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Cables & connectors | Connector
BPC900250014 | 2 meter extension cable 25A | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Cables & connectors | Cable
BPC900200014 | 2 meter extension cable (max. 20A) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Cables & connectors | Cable
BPC900120114 | Battery Indicator Eyelet (M8 eyelet / 30A ATO fuse) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Other accessory
BPC900110114 | Battery Indicator Panel (M8 eyelet connector / 30A ATO fuse) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Other accessory
BPC940100200 | Case for BPC chargers and accessories (12/25 and 24/13) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Mounting / protection
BPC940100100 | Case for BPC chargers and accessories (up to 12/15 and 24/8) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Mounting / protection
BPC900400014 | Clamp connector (with 30A ATO fuse) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Cables & connectors | Connector
BPC900100014 | M6 eyelet connector (with 30A ATO fuse) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Cables & connectors | Connector
BPC900110014 | M8 eyelet connector (with 30A ATO fuse) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Cables & connectors | Connector
BPC900500014 | MagCode Power Clip 12V  (max. 15A) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Other accessory
BPC900520014 | MagCode Power Port 12V (max. 15A) | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Other accessory
ADA010100300 | Mains Cord AU/NZ for Smart IP43 Charger 2m | Blue Power Chargers / Smart / Skylla-S Chargers and Mains Cords | Cables & connectors | Cable
ADA010100100 | Mains Cord CEE 7/7 for Smart IP43 Charger 2m | Blue Power Chargers / Smart / Skylla-S Chargers and Mains Cords | Cables & connectors | Cable
ADA010100400 | Mains Cord  NEMA 5-15P for Smart IP43 Charger 2m | Blue Power Chargers / Smart / Skylla-S Chargers and Mains Cords | Cables & connectors | Cable
ADA010100500 | Mains Cord  NEMA 6-15P for Smart IP43 Charger 2m | Blue Power Chargers / Smart / Skylla-S Chargers and Mains Cords | Cables & connectors | Cable
ADA010100200 | Mains Cord UK for Smart IP43 Charger 2m | Blue Power Chargers / Smart / Skylla-S Chargers and Mains Cords | Cables & connectors | Cable
BPC920100100 | Rubber bumper for Blue Smart IP65 Charger 12/10, 12/15, 24/8 | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Mounting / protection
BPC920100110 | Rubber bumper for Blue Smart IP65 Charger 12/25, 24/13 | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Mounting / protection
BPC920100200 | Wall Mount for Blue Smart IP65 Charger 12/10, 12/15, 24/8 | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Mounting / protection
BPC920100210 | Wall Mount for Blue Smart IP65 Charger 12/25, 24/13 | Blue Power Chargers / Accessories for Blue Power IP65 Chargers | Other accessories | Mounting / protection
ASS000200100 | CAN-bus Temp. sensor | DC-DC Converters / DC/DC Converters Non isolated | Other accessories | Sensor
ASS070300100 | Orion-Tr Isolated DC-DC Charger remote cable | DC-DC Converters / Orion-Tr Smart DC-DC charger with galvanic isolation | Cables & connectors | Cable
CIP050060000 | Fuse holder 6-way for MEGA-fuse | Electrical / MEGA Fuseholders and Fuses | Other accessories | Other accessory
CIP106100000 | Fuse holder for ANL-fuse | Electrical / ANL Fuseholders and Fuses | Other accessories | Other accessory
CIP000100001 | Fuse holder for MEGA-fuse | Electrical / MEGA Fuseholders and Fuses | Other accessories | Other accessory
CIP000050001 | Fuse holder for MIDI-fuse | Electrical / MIDI Fuseholders and Fuses | Other accessories | Other accessory
CIP100200100 | Modular fuse holder for MEGA-fuse | Electrical / MEGA Fuseholders and Fuses | Other accessories | Other accessory
ASS030550410 | Skylla-i remote on-off cable | High power chargers / Skylla-i | Cables & connectors | Cable
ASS030550400 | Skylla-i remote on-off cable *IF 0, order ASS030550410* | High power chargers / Skylla-i | Cables & connectors | Cable
SHP307700260 | Adapter Cord 16A/250V-CEE plug/Schuko Coupling | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Adapter
SHP307700220 | Adapter Cord 16A/250V-Schuko plug/CEE Coupling | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Adapter
SHP307700280 | Adapter Cord 16A to 32A/250V-CEE Plug 16A/CEE Coupling 32A | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Adapter
SHP307700300 | Adapter Cord 32A/3 to single ph.-CEE Plug 5P/CEE Coupling 3P | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Adapter
ASS030532010 | CANUSB interface | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030120210 | Interface MK2.2b (VE.Bus to RS232) | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030130010 | Interface MK2-USB (for Phoenix Charger only) | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030140030 | Interface MK3-USB-C (VE.Bus to USB-C) | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030140000 | Interface MK3-USB (VE.Bus to USB) | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030550120 | Inverting remote on-off cable | Miscellaneous / Cables | Cables & connectors | Cable
ASS030550220 | Non-inverting remote on-off cable | Miscellaneous / Cables | Cables & connectors | Cable
SHP301604000 | Plug 16A/250Vac (2p/3w) for Power Inlet 16A | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Connector
SHP303204000 | Plug 32A/250Vac (2p/3w) for Power Inlet 32A | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Connector
SHP301603000 | Power Inlet Polyamid with cover 16A/250Vac (2p/3w) | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Connector
SHP303202000 | Power Inlet stainless steel with cover 32A/250Vac (2p/3w) | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Connector
SHP301602000 | Power Inlet stainless with cover 16A/250Vac (2p/3w) | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Connector
ASS070400100 | Pre-charge cable | Miscellaneous / Miscellaneous | Cables & connectors | Cable
ASS030066004 | RJ12 UTP Cable 0,3 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066010 | RJ12 UTP Cable 0,9 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066009 | RJ12 UTP Cable 0,9 m *If 0, order ASS030066010* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066101 | RJ12 UTP Cable 10 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066100 | RJ12 UTP Cable 10 m *If 0, order ASS030066101* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066151 | RJ12 UTP Cable 15 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066150 | RJ12 UTP Cable 15 m *If 0, order ASS030066151* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066018 | RJ12 UTP Cable 1,8 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066301 | RJ12 UTP Cable 30 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066300 | RJ12 UTP Cable 30 m *If 0, order ASS030066301* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066031 | RJ12 UTP Cable 3 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066030 | RJ12 UTP Cable 3 m *If 0, order ASS030066031* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030066050 | RJ12 UTP Cable 5 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065511 | RJ45-splitter 1xRJ45 male/15cm cable/2xRJ45 female | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030065510 | RJ45splitter 1xRJ45male/2xRJ45fem.*If 0, order ASS030065511* | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030064901 | RJ45 UTP Cable 0,3 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030064900 | RJ45 UTP Cable 0,3 m *If 0, order ASS030064901* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030064921 | RJ45 UTP Cable 0,9 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065011 | RJ45 UTP Cable 10 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065021 | RJ45 UTP Cable 15 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065020 | RJ45 UTP Cable 15 m *If 0, order ASS030065021* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030064951 | RJ45 UTP Cable 1,8 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065031 | RJ45 UTP Cable 20 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065051 | RJ45 UTP Cable 30 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065050 | RJ45 UTP Cable 30 m *If 0, order ASS030065051* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030064981 | RJ45 UTP Cable 3 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030064980 | RJ45 UTP Cable 3 m *If 0, order ASS030064981* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030065001 | RJ45 UTP Cable 5 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030200000 | RS232 to USB converter | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030572018 | RS485 to USB interface 1.8m | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030572050 | RS485 to USB interface 5m | Miscellaneous / Cables | Cables & connectors | Adapter
SHP302501500 | Shore Power Cord 15m 16A/250Vac (3x2,5sqmm) | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Cable
SHP304001500 | Shore Power Cord 15m 25A/250Vac (3x4sqmm) | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Cable
SHP302502500 | Shore Power Cord 25m 16A/250Vac (3x2,5sqmm) | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Cable
SHP306002500 | Shore Power Cord 25m 32A/250Vac (3x6sqmm) | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Cable
SHP307700240 | Splitter Cord 16A/250V-CEE plug/2xCEE Coupling | Miscellaneous / Shore cables, inlets and accessories | Cables & connectors | Adapter
ASS030520115 | VE.Bus to VE.Can interface *Available until stock 0* | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030720018 | VECan-CANbus BMS typeB Cable 1,8 m*If 0, order ASS030720118* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030720050 | VECan-CAN-bus BMS type B Cable 5 m*If 0, order ASS030720150* | Miscellaneous / Cables | Cables & connectors | Cable
ASS030700000 | VE.Can RJ45 terminator (bag of 2) | Miscellaneous / Cables | Cables & connectors | Connector
ASS030710118 | VE.Can to CAN-bus BMS type A Cable 1,8 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030710150 | VE.Can to CAN-bus BMS type A Cable 5 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030720118 | VE.Can to CAN-bus BMS type B Cable 1,8 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030720150 | VE.Can to CAN-bus BMS type B Cable 5 m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030530203 | VE.Direct Cable 0,3m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030531203 | VE.Direct Cable 0,3m (one side Right Angle conn) | Miscellaneous / Cables | Cables & connectors | Cable
ASS030530209 | VE.Direct Cable 0,9m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030531209 | VE.Direct Cable 0,9m (one side Right Angle conn) | Miscellaneous / Cables | Cables & connectors | Cable
ASS030530310 | VE.Direct Cable 10m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030531320 | VE.Direct Cable 10m (one side Right Angle conn) | Miscellaneous / Cables | Cables & connectors | Cable
ASS030530218 | VE.Direct Cable 1,8m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030531218 | VE.Direct Cable 1,8m (one side Right Angle conn) | Miscellaneous / Cables | Cables & connectors | Cable
ASS030530230 | VE.Direct Cable 3m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030531230 | VE.Direct Cable 3m (one side Right Angle conn) | Miscellaneous / Cables | Cables & connectors | Cable
ASS030530250 | VE.Direct Cable 5m | Miscellaneous / Cables | Cables & connectors | Cable
ASS030531250 | VE.Direct Cable 5m (one side Right Angle conn) | Miscellaneous / Cables | Cables & connectors | Cable
ASS030550320 | VE.Direct non-inverting remote on-off cable | Miscellaneous / Cables | Cables & connectors | Cable
ASS030520500 | VE.Direct to RS232 interface | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030530030 | VE.Direct to USB-C interface | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030530010 | VE.Direct to USB interface | Miscellaneous / Cables | Cables & connectors | Adapter
ASS030550500 | VE.Direct TX digital output cable | Miscellaneous / Cables | Cables & connectors | Cable
CSE000100000 | AC Current sensor - single phase - max 40A | Remote panels & monitoring / GX Products | Other accessories | Sensor
GSM900200100 | Active GPS Antenna | Remote panels & monitoring / Remote panels & monitoring | Other accessories | Communication accessory
BPP900100200 | CCGX WiFi module simple (Nano USB) | Remote panels & monitoring / GX Products | Other accessories | Communication accessory
ADA500180100 | DIN35 adapter large (2 pcs) | Remote panels & monitoring / GX Products | Other accessories | Mounting / protection
ADA500140100 | DIN35 adapter medium (2 pcs) | Remote panels & monitoring / GX Products | Other accessories | Mounting / protection
ADA500100100 | DIN35 adapter small (2 pcs) | Remote panels & monitoring / GX Products | Other accessories | Mounting / protection
BPP900495100 | Ekrano GX Wall Mount | Remote panels & monitoring / GX Products | Other accessories | Mounting / protection
BPP900460050 | GX Touch 50 adapter for CCGX cut-out | Remote panels & monitoring / GX Products | Other accessories | Mounting / protection
BPP900465050 | GX Touch 50 Wall Mount | Remote panels & monitoring / GX Products | Other accessories | Mounting / protection
BPP900465070 | GX Touch 70 Wall Mount | Remote panels & monitoring / GX Products | Other accessories | Mounting / protection
BPP900200400 | GX WiFi module long range (Netgear AC1200) | Remote panels & monitoring / GX Products | Other accessories | Communication accessory
GSM900100100 | Outdoor 2G and 3G GSM Antenna | Remote panels & monitoring / Remote panels & monitoring | Other accessories | Communication accessory
GSM900100400 | Outdoor 4G GSM Antenna | Remote panels & monitoring / Remote panels & monitoring | Other accessories | Communication accessory
ANT100200200 | Outdoor LTE-M puck antenna (with 3m cable) | Remote panels & monitoring / Remote panels & monitoring | Other accessories | Communication accessory
ANT100200100 | Outdoor LTE-M wall-mount antenna (with 5m cable) | Remote panels & monitoring / Remote panels & monitoring | Other accessories | Mounting / protection
ASS000001000 | Temperature sensor QUA/PMP/Venus GX | Remote panels & monitoring / GX Products | Other accessories | Sensor
ASS000020000 | Temperature sensor type C | Remote panels & monitoring / GX Products | Other accessories | Sensor
ASS060000100 | USB extension cable 0,3m one side right angle | Remote panels & monitoring / Remote panels & monitoring | Cables & connectors | Cable
ASS030537010 | VE.Bus Smart dongle | Remote panels & monitoring / Remote panels & monitoring | Other accessories | Communication accessory
ASS030690000 | VE.Can Power Cable | Remote panels & monitoring / CAN-bus Products | Cables & connectors | Cable
BPP900600100 | VE.Can resistivetanksender adapter*If 0, order Cerbo GX MK2* | Remote panels & monitoring / CAN-bus Products | Cables & connectors | Adapter
ASS030536011 | VE.Direct Bluetooth Smart dongle | Remote panels & monitoring / Remote panels & monitoring | Other accessories | Communication accessory
SCC940100200 | BlueSolar PWM-Pro to USB interface cable | Solar chargers / PWM-Pro Charge Controllers | Cables & connectors | Adapter
SCC950300310 | MPPT WireBox-L MC4 150-70 & 250/70 VE.Can | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC950300210 | MPPT WireBox-L Tr 150-60/70 & 250-60/70 | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC950200000 | MPPT WireBox-M 100-30/50 & 150-35/45 | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC950120000 | MPPT WireBox-S 100-15 | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC950140000 | MPPT WireBox-S 100-20 | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC950100000 | MPPT WireBox-S 75-10/15 | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC950400310 | MPPT WireBox-XL MC4 150-85/100 & 250-85/100 VE.Can | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC950400210 | MPPT WireBox-XL Tr 150-85/100 & 250-85/100 VE.Can | Solar chargers / MPPT Wireboxes | Other accessories | Wirebox
SCC940100100 | Temp. sensor for BlueSolar PWM-Pro Charge Controller | Solar chargers / PWM-Pro Charge Controllers | Other accessories | Sensor
SPM041301200 | 130W-12V Mono 1200x668x30mm 4a *If 0, order SPM041303603* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPP041301200 | 130W-12V Poly 1200x668x30mm 4a *Available until stock 0* | Solar panels and cables / Solar panels polycrystalline | Solar panels | Solar panel
SPP041751200 | 175W-12V Poly 1485x668x30mm 4a *Available until stock 0* | Solar panels and cables / Solar panels polycrystalline | Solar panels | Solar panel
SPM041851200 | 185W-12V Mono 1485x668x30mm 4a *If 0, order SPM041903903* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040201200 | 20W-12V Mono 440x350x25mm 4a *If 0, order SPM040203603* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPP040201200 | 20W-12V Poly 440x350x25mm 4a *Available until stock 0* | Solar panels and cables / Solar panels polycrystalline | Solar panels | Solar panel
SPM042152402 | 215W-24V Mono 1580x705x35mm 4b *If 0, order SPM042357203* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM042357203 | 235W-72cells Mono 1350x880x30mm 4c*If 0, order SPM042357204* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPP042802000 | 280W-20V Poly 1650x992x35mm 4a *Available until stock 0* | Solar panels and cables / Solar panels polycrystalline | Solar panels | Solar panel
SPM040301200 | 30W-12V Mono 560x350x25mm 4a *If 0, order SPM040303603* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPP040301200 | 30W-12V Poly 655x350x25mm 4a *Available until stock 0* | Solar panels and cables / Solar panels polycrystalline | Solar panels | Solar panel
SPM040303603 | 30W-36 cells Mono 380x450x25mm 4c *If 0, order SPM040303604* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPP043302402 | 330W-24V Poly 1980x1002x40mm 4b *Available until stock 0* | Solar panels and cables / Solar panels polycrystalline | Solar panels | Solar panel
SPM043456803 | 345W-68 cells Mono1870x880x35mm 4c*If 0, order SPM043456804* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040401200 | 40W-12V Mono 425x668x25mm 4a *If 0, order SPM040403604* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPP040451200 | 45W-12V Poly 425x668x25mm 4a *Available until stock 0* | Solar panels and cables / Solar panels polycrystalline | Solar panels | Solar panel
SPM040551200 | 55W-12V Mono 545x668x25mm 4a *If 0, order SPM040553603* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040553603 | 55W-36 cells Mono 715x445x25mm 4c *If 0, order SPM040553604* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040901200 | 90W-12V Mono 780x668×30mm 4a *If 0, order SPM040953003* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040953003 | 95W-30 cells Mono 770x668×30mm 4c*If 0, order SPM040953004* | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SCA500200000 | Solar adaptercable MC4/F to MC3/M L=15cm | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Adapter
SCA500100000 | Solar adaptercable MC4/M to MC3/F L=15cm | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Adapter
SCA001000100 | Solarcable L=10m/6sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA000100000 | Solarcable L=1m/4sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA000100100 | Solarcable L=1m/6sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA002000100 | Solarcable L=20m/6sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA000300000 | Solarcable L=3m/4sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA000300100 | Solarcable L=3m/6sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA000500000 | Solarcable L=5m/4sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA000500100 | Solarcable L=5m/6sqmm MC4-M/F conn. (PV-ST01) | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Cable
SCA520300000 | Solar connector pair MC4, 1x Male/1x Female | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Connector
SPM041303603 | Solar Panel 130W-36 cells Mono 1020x668x30mm series 4c | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM041501200 | Solar Panel 150W-12V Mono 1485x668x30mm series 4a | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM041903903 | Solar Panel 190W-39 cells Mono 1485x668x30mm series 4c | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040203603 | Solar Panel 20W-36 cells Mono 275x450x25mm series 4c | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040303604 | Solar Panel 30W-36 cells Mono 380x450x25mm series 4d | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM043456804 | Solar Panel 345W-68 cells Mono 1870x880x35mm series 4d | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM043657203 | Solar Panel 365W-72 cells Mono 1980x880x35mm series 4c | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040403604 | Solar Panel 40W-36 cells Mono 540x450x25mm series 4d | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040553604 | Solar Panel 55W-36 cells Mono 715x445x25mm series 4d | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SPM040953004 | Solar Panel 95W-30 cells Mono 770x668×30mm series 4d | Solar panels and cables / Solar panels monocrystalline | Solar panels | Solar panel
SCA520500000 | Solar splitter pair MC4-Y, 1x M-2F / 1xF-2M | Solar panels and cables / Cables, connectors and accessories for solar panels | Cables & connectors | Adapter

## Numeric cable measurements

SKU | Name | Old length | Cable length (m) | Conductor size (mm²) | Family
--- | --- | --- | --- | --- | ---
ASS030560100 | M8 circular connector Male/Female 3 pole cable 1m (bag of 2) |  | 1 |  | 
ASS030560200 | M8 circular connector Male/Female 3 pole cable 2m (bag of 2) |  | 2 |  | 
ASS030560300 | M8 circular connector Male/Female 3 pole cable 3m (bag of 2) |  | 3 |  | 
ASS030560500 | M8 circular connector Male/Female 3 pole cable 5m (bag of 2) |  | 5 |  | 
BPC900250014 | 2 meter extension cable 25A |  | 2 |  | Charger lead
BPC900200014 | 2 meter extension cable (max. 20A) |  | 2 |  | Charger lead
ADA010100300 | Mains Cord AU/NZ for Smart IP43 Charger 2m |  | 2 |  | Mains power
ADA010100100 | Mains Cord CEE 7/7 for Smart IP43 Charger 2m |  | 2 |  | Mains power
ADA010100400 | Mains Cord  NEMA 5-15P for Smart IP43 Charger 2m |  | 2 |  | Mains power
ADA010100500 | Mains Cord  NEMA 6-15P for Smart IP43 Charger 2m |  | 2 |  | Mains power
ADA010100200 | Mains Cord UK for Smart IP43 Charger 2m |  | 2 |  | Mains power
ASS030066004 | RJ12 UTP Cable 0,3 m |  | 0.3 |  | RJ12
ASS030066010 | RJ12 UTP Cable 0,9 m |  | 0.9 |  | RJ12
ASS030066009 | RJ12 UTP Cable 0,9 m *If 0, order ASS030066010* |  | 0.9 |  | RJ12
ASS030066101 | RJ12 UTP Cable 10 m |  | 10 |  | RJ12
ASS030066100 | RJ12 UTP Cable 10 m *If 0, order ASS030066101* |  | 10 |  | RJ12
ASS030066151 | RJ12 UTP Cable 15 m |  | 15 |  | RJ12
ASS030066150 | RJ12 UTP Cable 15 m *If 0, order ASS030066151* |  | 15 |  | RJ12
ASS030066018 | RJ12 UTP Cable 1,8 m |  | 1.8 |  | RJ12
ASS030066301 | RJ12 UTP Cable 30 m |  | 30 |  | RJ12
ASS030066300 | RJ12 UTP Cable 30 m *If 0, order ASS030066301* |  | 30 |  | RJ12
ASS030066031 | RJ12 UTP Cable 3 m |  | 3 |  | RJ12
ASS030066030 | RJ12 UTP Cable 3 m *If 0, order ASS030066031* |  | 3 |  | RJ12
ASS030066050 | RJ12 UTP Cable 5 m |  | 5 |  | RJ12
ASS030065511 | RJ45-splitter 1xRJ45 male/15cm cable/2xRJ45 female |  | 0.15 |  | RJ45
ASS030064901 | RJ45 UTP Cable 0,3 m |  | 0.3 |  | RJ45
ASS030064900 | RJ45 UTP Cable 0,3 m *If 0, order ASS030064901* |  | 0.3 |  | RJ45
ASS030064921 | RJ45 UTP Cable 0,9 m |  | 0.9 |  | RJ45
ASS030065011 | RJ45 UTP Cable 10 m |  | 10 |  | RJ45
ASS030065021 | RJ45 UTP Cable 15 m |  | 15 |  | RJ45
ASS030065020 | RJ45 UTP Cable 15 m *If 0, order ASS030065021* |  | 15 |  | RJ45
ASS030064951 | RJ45 UTP Cable 1,8 m |  | 1.8 |  | RJ45
ASS030065031 | RJ45 UTP Cable 20 m |  | 20 |  | RJ45
ASS030065051 | RJ45 UTP Cable 30 m |  | 30 |  | RJ45
ASS030065050 | RJ45 UTP Cable 30 m *If 0, order ASS030065051* |  | 30 |  | RJ45
ASS030064981 | RJ45 UTP Cable 3 m |  | 3 |  | RJ45
ASS030064980 | RJ45 UTP Cable 3 m *If 0, order ASS030064981* |  | 3 |  | RJ45
ASS030065001 | RJ45 UTP Cable 5 m |  | 5 |  | RJ45
ASS030572018 | RS485 to USB interface 1.8m |  | 1.8 |  | USB
ASS030572050 | RS485 to USB interface 5m |  | 5 |  | USB
SHP302501500 | Shore Power Cord 15m 16A/250Vac (3x2,5sqmm) |  | 15 | 2.5 | Shore power
SHP304001500 | Shore Power Cord 15m 25A/250Vac (3x4sqmm) |  | 15 | 4 | Shore power
SHP302502500 | Shore Power Cord 25m 16A/250Vac (3x2,5sqmm) |  | 25 | 2.5 | Shore power
SHP306002500 | Shore Power Cord 25m 32A/250Vac (3x6sqmm) |  | 25 | 6 | Shore power
ASS030720018 | VECan-CANbus BMS typeB Cable 1,8 m*If 0, order ASS030720118* |  | 1.8 |  | VE.Can–BMS type B
ASS030720050 | VECan-CAN-bus BMS type B Cable 5 m*If 0, order ASS030720150* |  | 5 |  | VE.Can–BMS type B
ASS030710118 | VE.Can to CAN-bus BMS type A Cable 1,8 m |  | 1.8 |  | VE.Can–BMS type A
ASS030710150 | VE.Can to CAN-bus BMS type A Cable 5 m |  | 5 |  | VE.Can–BMS type A
ASS030720118 | VE.Can to CAN-bus BMS type B Cable 1,8 m |  | 1.8 |  | VE.Can–BMS type B
ASS030720150 | VE.Can to CAN-bus BMS type B Cable 5 m |  | 5 |  | VE.Can–BMS type B
ASS030530203 | VE.Direct Cable 0,3m |  | 0.3 |  | VE.Direct
ASS030531203 | VE.Direct Cable 0,3m (one side Right Angle conn) |  | 0.3 |  | VE.Direct
ASS030530209 | VE.Direct Cable 0,9m |  | 0.9 |  | VE.Direct
ASS030531209 | VE.Direct Cable 0,9m (one side Right Angle conn) |  | 0.9 |  | VE.Direct
ASS030530310 | VE.Direct Cable 10m |  | 10 |  | VE.Direct
ASS030531320 | VE.Direct Cable 10m (one side Right Angle conn) |  | 10 |  | VE.Direct
ASS030530218 | VE.Direct Cable 1,8m |  | 1.8 |  | VE.Direct
ASS030531218 | VE.Direct Cable 1,8m (one side Right Angle conn) |  | 1.8 |  | VE.Direct
ASS030530230 | VE.Direct Cable 3m |  | 3 |  | VE.Direct
ASS030531230 | VE.Direct Cable 3m (one side Right Angle conn) |  | 3 |  | VE.Direct
ASS030530250 | VE.Direct Cable 5m |  | 5 |  | VE.Direct
ASS030531250 | VE.Direct Cable 5m (one side Right Angle conn) |  | 5 |  | VE.Direct
ASS060000100 | USB extension cable 0,3m one side right angle |  | 0.3 |  | USB
SCA500200000 | Solar adaptercable MC4/F to MC3/M L=15cm | 0.15 m | 0.15 |  | Solar
SCA500100000 | Solar adaptercable MC4/M to MC3/F L=15cm | 0.15 m | 0.15 |  | Solar
SCA001000100 | Solarcable L=10m/6sqmm MC4-M/F conn. (PV-ST01) | 10 m | 10 | 6 | Solar
SCA000100000 | Solarcable L=1m/4sqmm MC4-M/F conn. (PV-ST01) | 1 m | 1 | 4 | Solar
SCA000100100 | Solarcable L=1m/6sqmm MC4-M/F conn. (PV-ST01) | 1 m | 1 | 6 | Solar
SCA002000100 | Solarcable L=20m/6sqmm MC4-M/F conn. (PV-ST01) | 20 m | 20 | 6 | Solar
SCA000300000 | Solarcable L=3m/4sqmm MC4-M/F conn. (PV-ST01) | 3 m | 3 | 4 | Solar
SCA000300100 | Solarcable L=3m/6sqmm MC4-M/F conn. (PV-ST01) | 3 m | 3 | 6 | Solar
SCA000500000 | Solarcable L=5m/4sqmm MC4-M/F conn. (PV-ST01) | 5 m | 5 | 4 | Solar
SCA000500100 | Solarcable L=5m/6sqmm MC4-M/F conn. (PV-ST01) | 5 m | 5 | 6 | Solar

## Uncertain products retained

These retain their supplier category and receive no guessed specifications. A reviewed per-product override can resolve them later.

SKU | Name | Category / subcategory | Reason
--- | --- | --- | ---
RNG-KIT-STCS200D-VOY20-G2-SA | 200 WATT 12 VOLT MONOCRYSTALLINE FOLDABLE SOLAR SUITCASE | solar_panel / - | No reliable specific product type; category retained and specifications left unset.
RNG-MTS-TMB-G1-SA | TMB Series | solar_panel / - | No reliable specific product type; category retained and specifications left unset.
RMT550TMB-G1-SA | TMB Series | solar_panel / - | No reliable specific product type; category retained and specifications left unset.
ITR000100102 | Autotransformer 120/240V-100A | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR000100101 | Autotransformer 120/240V-100A *If 0, order ITR000100102* | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR000100001 | Autotransformer 120/240V-32A *If 0, order ITR000100052* | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR000100052 | Autotransformer 120/240V-50A | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
GDI000016000 | Galvanic Isolator VDI-16 A | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
GDI000032000 | Galvanic Isolator VDI-32 A | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
GDI000064000 | Galvanic Isolator VDI-64 A | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR040452042 | Isolation Transformer 4500W 115/230V | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR050452042 | Isolation Transformer 4500W Auto 115/230V | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR000702001 | Isolation Transformer 7000W 230V *If 0, order ITR000802002* | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR040202041 | Iso Transformer 2000W 115/230V *If 0, order ITR040252043* | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR040362041 | Iso Transformer 3600W 115/230V *if 0, order ITR040452042* | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ITR050362041 | Iso.Transformer 3600W Auto115/230V*If 0, order ITR050452042* | Miscellaneous / Isolation Transformer | No reliable specific product type; category retained and specifications left unset.
ASS030520200 | VE.Can to NMEA2000 Micro-C male | Miscellaneous / Cables | No reliable specific product type; category retained and specifications left unset.
SLS300175100 | SolarSense 750 | Solar panels and cables / Cables, connectors and accessories for solar panels | No reliable specific product type; category retained and specifications left unset.

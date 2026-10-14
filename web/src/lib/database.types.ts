
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "api_rate_limits": {
                  Row: {
                    "requests": number,"token_id": string,"window_start": string
                  }
                  Insert: {
                    "requests": number,"token_id": string,"window_start": string
                  }
                  Update: {
                    "requests"?: number,"token_id"?: string,"window_start"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "api_rate_limits_token_id_fkey"
      columns: ["token_id"]
isOneToOne: false
      referencedRelation: "api_tokens"
      referencedColumns: ["id"]
    }
                  ]
                },"api_tokens": {
                  Row: {
                    "created_at": string,"expires_at": string | null,"id": string,"last_used_at": string | null,"lifetime_days": number | null,"name": string,"rotated_at": string | null,"scope": string,"token_hash": string,"token_prefix": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"expires_at"?: string | null,"id"?: string,"last_used_at"?: string | null,"lifetime_days"?: number | null,"name": string,"rotated_at"?: string | null,"scope": string,"token_hash": string,"token_prefix": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"expires_at"?: string | null,"id"?: string,"last_used_at"?: string | null,"lifetime_days"?: number | null,"name"?: string,"rotated_at"?: string | null,"scope"?: string,"token_hash"?: string,"token_prefix"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"aprs_packet_hours": {
                  Row: {
                    "hour_start": string,"packets": number
                  }
                  Insert: {
                    "hour_start": string,"packets": number
                  }
                  Update: {
                    "hour_start"?: string,"packets"?: number
                  }
                  Relationships: [
                    
                  ]
                },"aprs_packets": {
                  Row: {
                    "destination": string,"igate": string | null,"line": string,"line_md5": string,"packet_type": string,"path": string,"q_construct": string | null,"received_at": string,"source_call": string
                  }
                  Insert: {
                    "destination": string,"igate"?: string | null,"line": string,"line_md5": string,"packet_type": string,"path": string,"q_construct"?: string | null,"received_at": string,"source_call": string
                  }
                  Update: {
                    "destination"?: string,"igate"?: string | null,"line"?: string,"line_md5"?: string,"packet_type"?: string,"path"?: string,"q_construct"?: string | null,"received_at"?: string,"source_call"?: string
                  }
                  Relationships: [
                    
                  ]
                },"archive_log": {
                  Row: {
                    "archived_at": string,"bytes": number | null,"object_path": string | null,"row_count": number,"slice_end": string,"slice_start": string,"source": string
                  }
                  Insert: {
                    "archived_at"?: string,"bytes"?: number | null,"object_path"?: string | null,"row_count": number,"slice_end": string,"slice_start": string,"source": string
                  }
                  Update: {
                    "archived_at"?: string,"bytes"?: number | null,"object_path"?: string | null,"row_count"?: number,"slice_end"?: string,"slice_start"?: string,"source"?: string
                  }
                  Relationships: [
                    
                  ]
                },"callsign_activity": {
                  Row: {
                    "band": string | null,"base": string,"grain": string,"hours": (number)[],"mode_bucket": string,"period": string,"role": string,"source": string,"spots": number
                  }
                  Insert: {
                    "band"?: string | null,"base": string,"grain": string,"hours": (number)[],"mode_bucket": string,"period": string,"role": string,"source": string,"spots": number
                  }
                  Update: {
                    "band"?: string | null,"base"?: string,"grain"?: string,"hours"?: (number)[],"mode_bucket"?: string,"period"?: string,"role"?: string,"source"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"callsign_group_members": {
                  Row: {
                    "callsign": string,"group_id": string
                  }
                  Insert: {
                    "callsign": string,"group_id": string
                  }
                  Update: {
                    "callsign"?: string,"group_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "callsign_group_members_group_id_fkey"
      columns: ["group_id"]
isOneToOne: false
      referencedRelation: "callsign_groups"
      referencedColumns: ["id"]
    }
                  ]
                },"callsign_groups": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"callsign_licenses": {
                  Row: {
                    "authority": string,"callsign": string,"country": string | null,"expires_on": string | null,"granted_on": string | null,"grid": string | null,"loaded_at": string,"name": string | null,"operator_class": string | null,"state": string | null,"status": string | null
                  }
                  Insert: {
                    "authority": string,"callsign": string,"country"?: string | null,"expires_on"?: string | null,"granted_on"?: string | null,"grid"?: string | null,"loaded_at": string,"name"?: string | null,"operator_class"?: string | null,"state"?: string | null,"status"?: string | null
                  }
                  Update: {
                    "authority"?: string,"callsign"?: string,"country"?: string | null,"expires_on"?: string | null,"granted_on"?: string | null,"grid"?: string | null,"loaded_at"?: string,"name"?: string | null,"operator_class"?: string | null,"state"?: string | null,"status"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"callsign_profile_cache": {
                  Row: {
                    "callsign": string,"generated_at": string,"payload": NonNullable<Json>
                  }
                  Insert: {
                    "callsign": string,"generated_at": string,"payload": NonNullable<Json>
                  }
                  Update: {
                    "callsign"?: string,"generated_at"?: string,"payload"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"callsign_reach": {
                  Row: {
                    "base": string,"continent": string,"country": string,"grain": string,"period": string,"source": string,"spots": number
                  }
                  Insert: {
                    "base": string,"continent": string,"country": string,"grain": string,"period": string,"source": string,"spots": number
                  }
                  Update: {
                    "base"?: string,"continent"?: string,"country"?: string,"grain"?: string,"period"?: string,"source"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"callsign_references": {
                  Row: {
                    "base": string,"days": number,"first_day": string,"last_day": string,"location": string | null,"name": string | null,"program": string,"reference": string,"spots": number
                  }
                  Insert: {
                    "base": string,"days": number,"first_day": string,"last_day": string,"location"?: string | null,"name"?: string | null,"program": string,"reference": string,"spots": number
                  }
                  Update: {
                    "base"?: string,"days"?: number,"first_day"?: string,"last_day"?: string,"location"?: string | null,"name"?: string | null,"program"?: string,"reference"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"callsign_rollup_days": {
                  Row: {
                    "day": string,"rolled_at": string
                  }
                  Insert: {
                    "day": string,"rolled_at": string
                  }
                  Update: {
                    "day"?: string,"rolled_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"callsign_seen": {
                  Row: {
                    "base": string,"days_on_air": number,"first_spot": string,"last_frequency_khz": number,"last_mode": string | null,"last_spot": string
                  }
                  Insert: {
                    "base": string,"days_on_air": number,"first_spot": string,"last_frequency_khz": number,"last_mode"?: string | null,"last_spot": string
                  }
                  Update: {
                    "base"?: string,"days_on_air"?: number,"first_spot"?: string,"last_frequency_khz"?: number,"last_mode"?: string | null,"last_spot"?: string
                  }
                  Relationships: [
                    
                  ]
                },"callsign_variants": {
                  Row: {
                    "base": string,"callsign": string,"last_day": string,"spots": number
                  }
                  Insert: {
                    "base": string,"callsign": string,"last_day": string,"spots": number
                  }
                  Update: {
                    "base"?: string,"callsign"?: string,"last_day"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"cty_entities": {
                  Row: {
                    "continent": string,"cq_zone": number,"itu_zone": number,"lat": number,"lon": number,"name": string,"prefix": string
                  }
                  Insert: {
                    "continent": string,"cq_zone": number,"itu_zone": number,"lat": number,"lon": number,"name": string,"prefix": string
                  }
                  Update: {
                    "continent"?: string,"cq_zone"?: number,"itu_zone"?: number,"lat"?: number,"lon"?: number,"name"?: string,"prefix"?: string
                  }
                  Relationships: [
                    
                  ]
                },"cty_load": {
                  Row: {
                    "entities": number,"id": boolean,"loaded_at": string,"prefixes": number,"version": string | null
                  }
                  Insert: {
                    "entities": number,"id"?: boolean,"loaded_at": string,"prefixes": number,"version"?: string | null
                  }
                  Update: {
                    "entities"?: number,"id"?: boolean,"loaded_at"?: string,"prefixes"?: number,"version"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"cty_prefixes": {
                  Row: {
                    "continent": string,"cq_zone": number,"entity": string,"exact": boolean,"itu_zone": number,"pattern": string
                  }
                  Insert: {
                    "continent": string,"cq_zone": number,"entity": string,"exact": boolean,"itu_zone": number,"pattern": string
                  }
                  Update: {
                    "continent"?: string,"cq_zone"?: number,"entity"?: string,"exact"?: boolean,"itu_zone"?: number,"pattern"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cty_prefixes_entity_fkey"
      columns: ["entity"]
isOneToOne: false
      referencedRelation: "cty_entities"
      referencedColumns: ["prefix"]
    }
                  ]
                },"deliveries": {
                  Row: {
                    "attempts": number,"created_at": string,"destination_id": string,"id": number,"last_error": string | null,"sent_at": string | null,"spot_id": number,"status": string,"subscription_id": string
                  }
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"destination_id": string,"id"?: number,"last_error"?: string | null,"sent_at"?: string | null,"spot_id": number,"status"?: string,"subscription_id": string
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"destination_id"?: string,"id"?: number,"last_error"?: string | null,"sent_at"?: string | null,"spot_id"?: number,"status"?: string,"subscription_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "deliveries_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: false
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deliveries_spot_id_fkey"
      columns: ["spot_id"]
isOneToOne: false
      referencedRelation: "raw_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deliveries_spot_id_fkey"
      columns: ["spot_id"]
isOneToOne: false
      referencedRelation: "recent_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deliveries_subscription_id_fkey"
      columns: ["subscription_id"]
isOneToOne: false
      referencedRelation: "subscriptions"
      referencedColumns: ["id"]
    }
                  ]
                },"destinations": {
                  Row: {
                    "consecutive_failures": number,"created_at": string,"health": string,"id": string,"last_error": string | null,"last_error_at": string | null,"last_success_at": string | null,"name": string,"signing_secret": string | null,"type": string,"url": string,"url_display": string,"user_id": string
                  }
                  Insert: {
                    "consecutive_failures"?: number,"created_at"?: string,"health"?: string,"id"?: string,"last_error"?: string | null,"last_error_at"?: string | null,"last_success_at"?: string | null,"name": string,"signing_secret"?: string | null,"type": string,"url": string,"url_display": string,"user_id": string
                  }
                  Update: {
                    "consecutive_failures"?: number,"created_at"?: string,"health"?: string,"id"?: string,"last_error"?: string | null,"last_error_at"?: string | null,"last_success_at"?: string | null,"name"?: string,"signing_secret"?: string | null,"type"?: string,"url"?: string,"url_display"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"fcc_uls_am": {
                  Row: {
                    "operator_class": string | null,"usi": number
                  }
                  Insert: {
                    "operator_class"?: string | null,"usi": number
                  }
                  Update: {
                    "operator_class"?: string | null,"usi"?: number
                  }
                  Relationships: [
                    
                  ]
                },"fcc_uls_en": {
                  Row: {
                    "name": string | null,"state": string | null,"usi": number
                  }
                  Insert: {
                    "name"?: string | null,"state"?: string | null,"usi": number
                  }
                  Update: {
                    "name"?: string | null,"state"?: string | null,"usi"?: number
                  }
                  Relationships: [
                    
                  ]
                },"fcc_uls_hd": {
                  Row: {
                    "callsign": string,"expires_on": string | null,"granted_on": string | null,"status": string | null,"usi": number
                  }
                  Insert: {
                    "callsign": string,"expires_on"?: string | null,"granted_on"?: string | null,"status"?: string | null,"usi": number
                  }
                  Update: {
                    "callsign"?: string,"expires_on"?: string | null,"granted_on"?: string | null,"status"?: string | null,"usi"?: number
                  }
                  Relationships: [
                    
                  ]
                },"hidden_callsigns": {
                  Row: {
                    "callsign": string,"hidden_at": string,"note": string | null
                  }
                  Insert: {
                    "callsign": string,"hidden_at"?: string,"note"?: string | null
                  }
                  Update: {
                    "callsign"?: string,"hidden_at"?: string,"note"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"ingest_failures": {
                  Row: {
                    "error": string,"id": number,"occurred_at": string,"raw_payload": NonNullable<Json>,"source": string
                  }
                  Insert: {
                    "error": string,"id"?: number,"occurred_at"?: string,"raw_payload": NonNullable<Json>,"source": string
                  }
                  Update: {
                    "error"?: string,"id"?: number,"occurred_at"?: string,"raw_payload"?: NonNullable<Json>,"source"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ingest_state": {
                  Row: {
                    "consecutive_failures": number,"last_epoch": string | null,"last_error": string | null,"last_error_at": string | null,"last_run_at": string | null,"last_success_at": string | null,"source": string,"total_runs": number,"total_spots_ingested": number
                  }
                  Insert: {
                    "consecutive_failures"?: number,"last_epoch"?: string | null,"last_error"?: string | null,"last_error_at"?: string | null,"last_run_at"?: string | null,"last_success_at"?: string | null,"source": string,"total_runs"?: number,"total_spots_ingested"?: number
                  }
                  Update: {
                    "consecutive_failures"?: number,"last_epoch"?: string | null,"last_error"?: string | null,"last_error_at"?: string | null,"last_run_at"?: string | null,"last_success_at"?: string | null,"source"?: string,"total_runs"?: number,"total_spots_ingested"?: number
                  }
                  Relationships: [
                    
                  ]
                },"license_loads": {
                  Row: {
                    "applied_at": string | null,"authority": string,"counts": Json | null,"error": string | null,"id": number,"licenses": number | null,"ready_at": string | null,"started_at": string,"status": string,"version": string
                  }
                  Insert: {
                    "applied_at"?: string | null,"authority": string,"counts"?: Json | null,"error"?: string | null,"id"?: never,"licenses"?: number | null,"ready_at"?: string | null,"started_at"?: string,"status"?: string,"version": string
                  }
                  Update: {
                    "applied_at"?: string | null,"authority"?: string,"counts"?: Json | null,"error"?: string | null,"id"?: never,"licenses"?: number | null,"ready_at"?: string | null,"started_at"?: string,"status"?: string,"version"?: string
                  }
                  Relationships: [
                    
                  ]
                },"lookup_rate_limits": {
                  Row: {
                    "client": string,"lookups": number,"window_start": string
                  }
                  Insert: {
                    "client": string,"lookups": number,"window_start": string
                  }
                  Update: {
                    "client"?: string,"lookups"?: number,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "callsign": string,"created_at": string,"id": string,"name": string,"timezone": string,"utc_times": boolean
                  }
                  Insert: {
                    "callsign": string,"created_at"?: string,"id": string,"name"?: string,"timezone"?: string,"utc_times"?: boolean
                  }
                  Update: {
                    "callsign"?: string,"created_at"?: string,"id"?: string,"name"?: string,"timezone"?: string,"utc_times"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"raw_spots": {
                  Row: {
                    "band": string | null,"base_callsign": string | null,"callsign": string,"comment": string,"content_hash": string,"frequency_khz": number,"id": number,"ingested_at": string,"mode": string | null,"mode_family": string | null,"pota_location": string | null,"pota_park_name": string | null,"pota_reference": string | null,"raw_payload": NonNullable<Json>,"sota_summit_ref": string | null,"source": string,"source_spot_id": string,"spot_time": string,"spotter": string | null
                  }
                  Insert: {
                    "band"?: string | null,"base_callsign"?: never,"callsign": string,"comment"?: string,"content_hash": string,"frequency_khz": number,"id"?: number,"ingested_at"?: string,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"raw_payload": NonNullable<Json>,"sota_summit_ref"?: string | null,"source": string,"source_spot_id": string,"spot_time": string,"spotter"?: string | null
                  }
                  Update: {
                    "band"?: string | null,"base_callsign"?: never,"callsign"?: string,"comment"?: string,"content_hash"?: string,"frequency_khz"?: number,"id"?: number,"ingested_at"?: string,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"raw_payload"?: NonNullable<Json>,"sota_summit_ref"?: string | null,"source"?: string,"source_spot_id"?: string,"spot_time"?: string,"spotter"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"rbn_daily_skimmers": {
                  Row: {
                    "band": string | null,"day": string,"spots": number,"spotter": string
                  }
                  Insert: {
                    "band"?: string | null,"day": string,"spots": number,"spotter": string
                  }
                  Update: {
                    "band"?: string | null,"day"?: string,"spots"?: number,"spotter"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rbn_daily_stations": {
                  Row: {
                    "callsign": string,"day": string,"spots": number
                  }
                  Insert: {
                    "callsign": string,"day": string,"spots": number
                  }
                  Update: {
                    "callsign"?: string,"day"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"rbn_hourly": {
                  Row: {
                    "hour": string,"spots": number
                  }
                  Insert: {
                    "hour": string,"spots": number
                  }
                  Update: {
                    "hour"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"rbn_rollup_days": {
                  Row: {
                    "day": string,"rolled_at": string
                  }
                  Insert: {
                    "day": string,"rolled_at": string
                  }
                  Update: {
                    "day"?: string,"rolled_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rbn_rollup_hours": {
                  Row: {
                    "hour": string,"rolled_at": string
                  }
                  Insert: {
                    "hour": string,"rolled_at": string
                  }
                  Update: {
                    "hour"?: string,"rolled_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rbn_spots": {
                  Row: {
                    "band": string | null,"callsign": string,"frequency_khz": number,"ingested_at": string,"line": string,"mode": string | null,"mode_family": string | null,"received_at": string,"snr": number,"speed": number,"speed_unit": string,"spot_time": string,"spot_type": string,"spotter": string
                  }
                  Insert: {
                    "band"?: string | null,"callsign": string,"frequency_khz": number,"ingested_at"?: string,"line": string,"mode"?: string | null,"mode_family"?: string | null,"received_at": string,"snr": number,"speed": number,"speed_unit": string,"spot_time": string,"spot_type": string,"spotter": string
                  }
                  Update: {
                    "band"?: string | null,"callsign"?: string,"frequency_khz"?: number,"ingested_at"?: string,"line"?: string,"mode"?: string | null,"mode_family"?: string | null,"received_at"?: string,"snr"?: number,"speed"?: number,"speed_unit"?: string,"spot_time"?: string,"spot_type"?: string,"spotter"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rbn_top_stations": {
                  Row: {
                    "callsign": string,"skimmers": number,"spots": number,"window_start": string
                  }
                  Insert: {
                    "callsign": string,"skimmers": number,"spots": number,"window_start": string
                  }
                  Update: {
                    "callsign"?: string,"skimmers"?: number,"spots"?: number,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"sign_in_attempts": {
                  Row: {
                    "attempted_at": string,"id": number,"identifier": string
                  }
                  Insert: {
                    "attempted_at"?: string,"id"?: number,"identifier": string
                  }
                  Update: {
                    "attempted_at"?: string,"id"?: number,"identifier"?: string
                  }
                  Relationships: [
                    
                  ]
                },"stats_snapshots": {
                  Row: {
                    "generated_at": string,"id": number,"payload": NonNullable<Json>,"window_end": string,"window_start": string
                  }
                  Insert: {
                    "generated_at"?: string,"id"?: number,"payload": NonNullable<Json>,"window_end": string,"window_start": string
                  }
                  Update: {
                    "generated_at"?: string,"id"?: number,"payload"?: NonNullable<Json>,"window_end"?: string,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"subscription_destinations": {
                  Row: {
                    "destination_id": string,"subscription_id": string
                  }
                  Insert: {
                    "destination_id": string,"subscription_id": string
                  }
                  Update: {
                    "destination_id"?: string,"subscription_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "subscription_destinations_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: false
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "subscription_destinations_subscription_id_fkey"
      columns: ["subscription_id"]
isOneToOne: false
      referencedRelation: "subscriptions"
      referencedColumns: ["id"]
    }
                  ]
                },"subscription_quiet": {
                  Row: {
                    "callsign": string,"last_sent_at": string,"subscription_id": string
                  }
                  Insert: {
                    "callsign": string,"last_sent_at": string,"subscription_id": string
                  }
                  Update: {
                    "callsign"?: string,"last_sent_at"?: string,"subscription_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "subscription_quiet_subscription_id_fkey"
      columns: ["subscription_id"]
isOneToOne: false
      referencedRelation: "subscriptions"
      referencedColumns: ["id"]
    }
                  ]
                },"subscriptions": {
                  Row: {
                    "bands": (string)[],"callsigns": (string)[],"created_at": string,"enabled": boolean,"group_ids": (string)[],"id": string,"modes": (string)[],"name": string,"quiet_minutes": number,"reference": string,"sources": (string)[],"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "bands"?: (string)[],"callsigns"?: (string)[],"created_at"?: string,"enabled"?: boolean,"group_ids"?: (string)[],"id"?: string,"modes"?: (string)[],"name": string,"quiet_minutes"?: number,"reference"?: string,"sources"?: (string)[],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "bands"?: (string)[],"callsigns"?: (string)[],"created_at"?: string,"enabled"?: boolean,"group_ids"?: (string)[],"id"?: string,"modes"?: (string)[],"name"?: string,"quiet_minutes"?: number,"reference"?: string,"sources"?: (string)[],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "archive_status": {
                  Row: {
                    "archived_through": string | null,"pending_slices": number | null,"source": string | null
                  }
                  Relationships: [
                    
                  ]
                },"ingest_health": {
                  Row: {
                    "consecutive_failures": number | null,"last_error": string | null,"last_run_at": string | null,"last_success_at": string | null,"seconds_since_last_success": number | null,"source": string | null,"spots_last_24h": number | null,"spots_last_hour": number | null,"total_spots_ingested": number | null
                  }
                  Insert: {
                           "consecutive_failures"?: number | null,"last_error"?: string | null,"last_run_at"?: string | null,"last_success_at"?: string | null,"seconds_since_last_success"?: never,"source"?: string | null,"spots_last_24h"?: never,"spots_last_hour"?: never,"total_spots_ingested"?: number | null
                         }
                        Update: {
                           "consecutive_failures"?: number | null,"last_error"?: string | null,"last_run_at"?: string | null,"last_success_at"?: string | null,"seconds_since_last_success"?: never,"source"?: string | null,"spots_last_24h"?: never,"spots_last_hour"?: never,"total_spots_ingested"?: number | null
                         }
                        Relationships: [
                    
                  ]
                },"recent_spots": {
                  Row: {
                    "band": string | null,"callsign": string | null,"comment": string | null,"frequency_khz": number | null,"id": number | null,"mode": string | null,"mode_family": string | null,"pota_location": string | null,"pota_park_name": string | null,"pota_reference": string | null,"sota_summit_ref": string | null,"source": string | null,"spot_time": string | null,"spotter": string | null
                  }
                  Insert: {
                           "band"?: string | null,"callsign"?: string | null,"comment"?: string | null,"frequency_khz"?: number | null,"id"?: number | null,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"sota_summit_ref"?: string | null,"source"?: string | null,"spot_time"?: string | null,"spotter"?: string | null
                         }
                        Update: {
                           "band"?: string | null,"callsign"?: string | null,"comment"?: string | null,"frequency_khz"?: number | null,"id"?: number | null,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"sota_summit_ref"?: string | null,"source"?: string | null,"spot_time"?: string | null,"spotter"?: string | null
                         }
                        Relationships: [
                    
                  ]
                },"spot_stream": {
                  Row: {
                    "band": string | null,"base_callsign": string | null,"callsign": string | null,"frequency_khz": number | null,"mode": string | null,"mode_bucket": string | null,"program": string | null,"reference": string | null,"reference_location": string | null,"reference_name": string | null,"snr": number | null,"source": string | null,"spot_time": string | null,"spotter": string | null,"spotter_base": string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "apply_license_loads":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"api_call":
{ Args: { "p_args": Json,"p_op": string,"p_token_id": string }; Returns: Json
                           },
"api_destination_json":
{ Args: { "d": Database["public"]["Tables"]["destinations"]["Row"] }; Returns: Json
                           },
"api_subscription_json":
{ Args: { "s": Database["public"]["Tables"]["subscriptions"]["Row"] }; Returns: Json
                           },
"aprs_day_archived":
{ Args: { "p_day": string }; Returns: boolean
                           },
"aprs_day_slices":
{ Args: { "p_day": string }; Returns: {
              "archived_rows": number,"db_rows": number,"slice_start": string
            }[]
                           },
"archive_ndjson":
{ Args: { "p_from": string,"p_source": string,"p_to": string }; Returns: {
              "ndjson": string,"row_count": number
            }[]
                           },
"archive_pending_slices":
{ Args: { "p_before": string,"p_limit": number,"p_source": string }; Returns: {
              "slice_end": string,"slice_start": string
            }[]
                           },
"archive_slice_minutes":
{ Args: { "p_source": string }; Returns: number
                           },
"authenticate_api_request":
{ Args: { "p_token_hash": string }; Returns: {
              "requests": number,"scope": string,"token_id": string,"user_id": string
            }[]
                           },
"backfill_callsign_rollups":
{ Args: { "p_max_days"?: number }; Returns: {
              "error": string,"rollup_day": string,"spots": number
            }[]
                           },
"base_callsign":
{ Args: { "p_call": string }; Returns: string
                           },
"cached_callsign_profile":
{ Args: { "p_callsign": string }; Returns: Json
                           },
"callsign_available":
{ Args: { "p_callsign": string }; Returns: boolean
                           },
"callsign_matches":
{ Args: { "p_base": string,"p_call": string,"p_callsigns": (string)[] }; Returns: boolean
                           },
"callsign_profile":
{ Args: { "p_callsign": string }; Returns: Json
                           },
"claim_deliveries":
{ Args: { "p_limit"?: number,"p_vt"?: number }; Returns: {
              "attempts": number,"created_at": string,"delivery_id": number,"destination": Json,"msg_id": number,"spot": Json,"subscription_id": string
            }[]
                           },
"compact_callsign_rollups":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"create_api_token":
{ Args: { "p_lifetime_days"?: number,"p_name": string,"p_scope": string }; Returns: {
              "created_at": string,"expires_at": string,"id": string,"lifetime_days": number,"name": string,"scope": string,"token": string,"token_prefix": string
            }[]
                           },
"create_aprs_packets_partition":
{ Args: { "p_day": string }; Returns: undefined
                           },
"create_destination":
{ Args: { "p_name": string,"p_type": string,"p_url": string }; Returns: {
              "created_at": string,"health": string,"id": string,"name": string,"signing_secret": string,"type": string,"url_display": string
            }[]
                           },
"create_rbn_spots_partition":
{ Args: { "p_day": string }; Returns: undefined
                           },
"cty_lookup":
{ Args: { "p_call": string }; Returns: {
              "continent": string,"cq_zone": number,"entity": string,"itu_zone": number,"name": string
            }[]
                           },
"delay_deliveries":
{ Args: { "p_delay_seconds": number,"p_msg_ids": (number)[] }; Returns: undefined
                           },
"delete_callsign_group":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_destination":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_subscription":
{ Args: { "p_id": string }; Returns: undefined
                           },
"destination_url_display":
{ Args: { "p_type": string,"p_url": string }; Returns: string
                           },
"edit_group_callsigns":
{ Args: { "p_add": Json,"p_id": string,"p_remove": Json }; Returns: undefined
                           },
"edit_subscription_callsigns":
{ Args: { "p_add": Json,"p_id": string,"p_remove": Json }; Returns: (string)[]
                           },
"email_for_identifier":
{ Args: { "p_identifier": string }; Returns: string
                           },
"fcc_license_load_abandon":
{ Args: { "p_error": string,"p_load": number }; Returns: undefined
                           },
"fcc_license_load_begin":
{ Args: { "p_version": string }; Returns: number
                           },
"fcc_license_load_finish":
{ Args: { "p_counts": Json,"p_load": number }; Returns: undefined
                           },
"fcc_license_load_rows":
{ Args: { "p_kind": string,"p_load": number,"p_rows": Json }; Returns: number
                           },
"fcc_license_load_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"fcc_license_staged_counts":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"group_matches":
{ Args: { "p_base": string,"p_group_ids": (string)[] }; Returns: boolean
                           },
"ingest_aprs_packets":
{ Args: { "p_rows": Json }; Returns: number
                           },
"ingest_rbn_spots":
{ Args: { "p_rows": Json }; Returns: number
                           },
"ingest_spots":
{ Args: { "p_spots": Json }; Returns: {
              "id": number,"source": string,"source_spot_id": string
            }[]
                           },
"int_array_add":
{ Args: { "p_a": (number)[],"p_b": (number)[] }; Returns: (number)[]
                           },
"is_private_host":
{ Args: { "p_host": string }; Returns: boolean
                           },
"is_self_spot":
{ Args: { "p_callsign": string,"p_spotter": string }; Returns: boolean
                           },
"jsonb_text_array":
{ Args: { "p_case": string,"p_values": Json }; Returns: (string)[]
                           },
"last_rollup_day":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"list_callsign_groups":
{ Args: Record<PropertyKey, never>; Returns: {
              "callsigns": (string)[],"id": string,"member_count": number,"name": string,"on_air": Json,"subscription_count": number,"updated_at": string
            }[]
                           },
"list_ingest_health":
{ Args: Record<PropertyKey, never>; Returns: {
              "consecutive_failures": number | null,
"last_error": string | null,
"last_run_at": string | null,
"last_success_at": string | null,
"seconds_since_last_success": number | null,
"source": string | null,
"spots_last_24h": number | null,
"spots_last_hour": number | null,
"total_spots_ingested": number | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "ingest_health"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_recent_spots":
{ Args: { "max_rows": number,"p_source": string }; Returns: {
              "band": string | null,
"callsign": string | null,
"comment": string | null,
"frequency_khz": number | null,
"id": number | null,
"mode": string | null,
"mode_family": string | null,
"pota_location": string | null,
"pota_park_name": string | null,
"pota_reference": string | null,
"sota_summit_ref": string | null,
"source": string | null,
"spot_time": string | null,
"spotter": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "recent_spots"
        isOneToOne: false
        isSetofReturn: true
      } },
"load_cty":
{ Args: { "p_entities": Json,"p_prefixes": Json,"p_version": string }; Returns: undefined
                           },
"log_archive":
{ Args: { "p_bytes": number,"p_object_path": string,"p_row_count": number,"p_slice_end": string,"p_slice_start": string,"p_source": string }; Returns: undefined
                           },
"maintain_aprs_packets":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"maintain_rbn_spots":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"mark_deliveries_dropped":
{ Args: { "p_delivery_ids": (number)[],"p_msg_ids": (number)[] }; Returns: undefined
                           },
"mark_deliveries_failed":
{ Args: { "p_delay_seconds": number,"p_delivery_ids": (number)[],"p_error": string,"p_msg_ids": (number)[] }; Returns: undefined
                           },
"mark_deliveries_sent":
{ Args: { "p_delivery_ids": (number)[],"p_msg_ids": (number)[] }; Returns: undefined
                           },
"match_pending_spots":
{ Args: { "batch_size"?: number }; Returns: number
                           },
"mode_bucket":
{ Args: { "p_family": string,"p_mode": string }; Returns: string
                           },
"new_api_token":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"normalize_group_callsigns":
{ Args: { "p_calls": (string)[] }; Returns: Json
                           },
"parse_https_url":
{ Args: { "p_url": string }; Returns: (string)[]
                           },
"patch_callsign_group":
{ Args: { "p_id": string,"p_patch": Json }; Returns: undefined
                           },
"patch_subscription":
{ Args: { "p_id": string,"p_patch": Json }; Returns: undefined
                           },
"preview_subscription":
{ Args: { "filter": Json }; Returns: {
              "count": number,"spots": Json,"station_count": number
            }[]
                           },
"prune_callsign_lookups":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"rbn_day_archived":
{ Args: { "p_day": string }; Returns: boolean
                           },
"rbn_day_slices":
{ Args: { "p_day": string }; Returns: {
              "archived_rows": number,"db_rows": number,"slice_start": string
            }[]
                           },
"rebase_callsign_group_members":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"record_ingest_failure":
{ Args: { "p_error": string,"p_source": string }; Returns: undefined
                           },
"record_ingest_success":
{ Args: { "p_epoch"?: string,"p_inserted": number,"p_source": string }; Returns: undefined
                           },
"record_profile_lookup":
{ Args: { "p_client": string }; Returns: number
                           },
"record_sign_in_attempt":
{ Args: { "p_identifier": string }; Returns: number
                           },
"refresh_stats_snapshot":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"refresh_stats_snapshot_at":
{ Args: { "p_now": string }; Returns: undefined
                           },
"retire_aprs_day":
{ Args: { "p_day": string }; Returns: undefined
                           },
"retire_rbn_day":
{ Args: { "p_day": string }; Returns: undefined
                           },
"rollup_callsign_day":
{ Args: { "p_day": string,"p_without_rbn"?: boolean }; Returns: number
                           },
"rollup_rbn_day":
{ Args: { "p_day": string }; Returns: undefined
                           },
"rollup_rbn_hours":
{ Args: { "p_from": string,"p_to": string }; Returns: undefined
                           },
"rotate_api_token":
{ Args: { "p_id": string }; Returns: {
              "expires_at": string,"token": string,"token_prefix": string
            }[]
                           },
"rotate_signing_secret":
{ Args: { "p_destination_id": string }; Returns: string
                           },
"run_housekeeping":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"save_callsign_group":
{ Args: { "payload": Json }; Returns: string
                           },
"save_subscription":
{ Args: { "payload": Json }; Returns: string
                           },
"source_matches":
{ Args: { "p_source": string,"p_sources": (string)[] }; Returns: boolean
                           },
"spot_matches":
{ Args: { "spot": Database["public"]['Tables']["raw_spots"]['Row'],"sub": Database["public"]['Tables']["subscriptions"]['Row'] }; Returns: boolean
                           },
"stats_payload_without_hidden":
{ Args: { "p_payload": Json }; Returns: Json
                           },
"update_destination":
{ Args: { "p_id": string,"p_name": string,"p_url": string }; Returns: undefined
                           },
"validate_destination_url":
{ Args: { "p_type": string,"p_url": string }; Returns: undefined
                           },
"watched_among":
{ Args: { "p_callsigns": (string)[],"p_source": string }; Returns: string[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const

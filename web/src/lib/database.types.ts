
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
                  ComputedFields: never
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
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"expires_at"?: string | null,"id"?: string,"last_used_at"?: string | null,"lifetime_days"?: number | null,"name": string,"rotated_at"?: string | null,"scope": string,"token_hash": string,"token_prefix": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"expires_at"?: string | null,"id"?: string,"last_used_at"?: string | null,"lifetime_days"?: number | null,"name"?: string,"rotated_at"?: string | null,"scope"?: string,"token_hash"?: string,"token_prefix"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"aprs_daily_igates": {
                  Row: {
                    "day": string,"igate": string
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"igate": string
                  }
                  Update: {
                    "day"?: string,"igate"?: string
                  }
                  Relationships: [
                    
                  ]
                },"aprs_daily_stations": {
                  Row: {
                    "base": string,"day": string
                  }
                  ComputedFields: never
                  Insert: {
                    "base": string,"day": string
                  }
                  Update: {
                    "base"?: string,"day"?: string
                  }
                  Relationships: [
                    
                  ]
                },"aprs_daily_types": {
                  Row: {
                    "day": string,"packet_type": string,"packets": number
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"packet_type": string,"packets": number
                  }
                  Update: {
                    "day"?: string,"packet_type"?: string,"packets"?: number
                  }
                  Relationships: [
                    
                  ]
                },"aprs_packet_hours": {
                  Row: {
                    "hour_start": string,"packets": number
                  }
                  ComputedFields: never
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
                  ComputedFields: never
                  Insert: {
                    "destination": string,"igate"?: string | null,"line": string,"line_md5": string,"packet_type": string,"path": string,"q_construct"?: string | null,"received_at": string,"source_call": string
                  }
                  Update: {
                    "destination"?: string,"igate"?: string | null,"line"?: string,"line_md5"?: string,"packet_type"?: string,"path"?: string,"q_construct"?: string | null,"received_at"?: string,"source_call"?: string
                  }
                  Relationships: [
                    
                  ]
                },"aprs_rollup_days": {
                  Row: {
                    "day": string,"rolled_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"rolled_at": string
                  }
                  Update: {
                    "day"?: string,"rolled_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"archive_log": {
                  Row: {
                    "archived_at": string,"bytes": number | null,"object_path": string | null,"row_count": number,"slice_end": string,"slice_start": string,"source": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string,"bytes"?: number | null,"object_path"?: string | null,"row_count": number,"slice_end": string,"slice_start": string,"source": string
                  }
                  Update: {
                    "archived_at"?: string,"bytes"?: number | null,"object_path"?: string | null,"row_count"?: number,"slice_end"?: string,"slice_start"?: string,"source"?: string
                  }
                  Relationships: [
                    
                  ]
                },"band_map_cache": {
                  Row: {
                    "generated_at": string,"id": boolean,"payload": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "generated_at": string,"id"?: boolean,"payload": NonNullable<Json>
                  }
                  Update: {
                    "generated_at"?: string,"id"?: boolean,"payload"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"callsign_activity": {
                  Row: {
                    "band": string | null,"base": string,"grain": string,"hours": (number)[],"mode_bucket": string,"period": string,"role": string,"source": string,"spots": number
                  }
                  ComputedFields: never
                  Insert: {
                    "band"?: string | null,"base": string,"grain": string,"hours": (number)[],"mode_bucket": string,"period": string,"role": string,"source": string,"spots": number
                  }
                  Update: {
                    "band"?: string | null,"base"?: string,"grain"?: string,"hours"?: (number)[],"mode_bucket"?: string,"period"?: string,"role"?: string,"source"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"callsign_days": {
                  Row: {
                    "bands": (string)[],"base": string,"day": string,"modes": (string)[],"source": string,"spots": number
                  }
                  ComputedFields: never
                  Insert: {
                    "bands": (string)[],"base": string,"day": string,"modes": (string)[],"source": string,"spots": number
                  }
                  Update: {
                    "bands"?: (string)[],"base"?: string,"day"?: string,"modes"?: (string)[],"source"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"callsign_group_members": {
                  Row: {
                    "callsign": string,"group_id": string
                  }
                  ComputedFields: never
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
                    "created_at": string,"id": string,"name": string,"public": boolean,"public_slug": string | null,"show_callsigns": boolean,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"public"?: boolean,"public_slug"?: string | null,"show_callsigns"?: boolean,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"public"?: boolean,"public_slug"?: string | null,"show_callsigns"?: boolean,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"callsign_licenses": {
                  Row: {
                    "authority": string,"callsign": string,"country": string | null,"expires_on": string | null,"first_name": string | null,"granted_on": string | null,"grid": string | null,"last_name": string | null,"loaded_at": string,"name": string | null,"operator_class": string | null,"state": string | null,"status": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "authority": string,"callsign": string,"country"?: string | null,"expires_on"?: string | null,"first_name"?: string | null,"granted_on"?: string | null,"grid"?: string | null,"last_name"?: string | null,"loaded_at": string,"name"?: string | null,"operator_class"?: string | null,"state"?: string | null,"status"?: string | null
                  }
                  Update: {
                    "authority"?: string,"callsign"?: string,"country"?: string | null,"expires_on"?: string | null,"first_name"?: string | null,"granted_on"?: string | null,"grid"?: string | null,"last_name"?: string | null,"loaded_at"?: string,"name"?: string | null,"operator_class"?: string | null,"state"?: string | null,"status"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"callsign_profile_cache": {
                  Row: {
                    "callsign": string,"generated_at": string,"payload": NonNullable<Json>
                  }
                  ComputedFields: never
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
                  ComputedFields: never
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
                  ComputedFields: never
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
                    "day": string,"days_filled_at": string | null,"references_filled_at": string | null,"rolled_at": string,"spots": number | null,"without_rbn": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"days_filled_at"?: string | null,"references_filled_at"?: string | null,"rolled_at": string,"spots"?: number | null,"without_rbn"?: boolean
                  }
                  Update: {
                    "day"?: string,"days_filled_at"?: string | null,"references_filled_at"?: string | null,"rolled_at"?: string,"spots"?: number | null,"without_rbn"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"callsign_rollup_failures": {
                  Row: {
                    "attempts": number,"day": string,"first_failed_at": string,"last_error": string,"last_failed_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts": number,"day": string,"first_failed_at": string,"last_error": string,"last_failed_at": string
                  }
                  Update: {
                    "attempts"?: number,"day"?: string,"first_failed_at"?: string,"last_error"?: string,"last_failed_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"callsign_seen": {
                  Row: {
                    "base": string,"days_on_air": number,"first_spot": string,"last_frequency_khz": number,"last_mode": string | null,"last_spot": string
                  }
                  ComputedFields: never
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
                  ComputedFields: never
                  Insert: {
                    "base": string,"callsign": string,"last_day": string,"spots": number
                  }
                  Update: {
                    "base"?: string,"callsign"?: string,"last_day"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"country_daily_spots": {
                  Row: {
                    "day": string,"entity": string,"source": string,"spots": number
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"entity": string,"source": string,"spots": number
                  }
                  Update: {
                    "day"?: string,"entity"?: string,"source"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"country_rollup_days": {
                  Row: {
                    "day": string,"rolled_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "day": string,"rolled_at": string
                  }
                  Update: {
                    "day"?: string,"rolled_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"cron_http_requests": {
                  Row: {
                    "answered_at": string | null,"job": string,"request_id": number,"run_seconds": number | null,"sent_at": string,"status_code": number | null,"timed_out": boolean | null
                  }
                  ComputedFields: never
                  Insert: {
                    "answered_at"?: string | null,"job": string,"request_id": number,"run_seconds"?: number | null,"sent_at"?: string,"status_code"?: number | null,"timed_out"?: boolean | null
                  }
                  Update: {
                    "answered_at"?: string | null,"job"?: string,"request_id"?: number,"run_seconds"?: number | null,"sent_at"?: string,"status_code"?: number | null,"timed_out"?: boolean | null
                  }
                  Relationships: [
                    
                  ]
                },"cty_entities": {
                  Row: {
                    "continent": string,"cq_zone": number,"itu_zone": number,"lat": number,"lon": number,"name": string,"prefix": string
                  }
                  ComputedFields: never
                  Insert: {
                    "continent": string,"cq_zone": number,"itu_zone": number,"lat": number,"lon": number,"name": string,"prefix": string
                  }
                  Update: {
                    "continent"?: string,"cq_zone"?: number,"itu_zone"?: number,"lat"?: number,"lon"?: number,"name"?: string,"prefix"?: string
                  }
                  Relationships: [
                    
                  ]
                },"cty_entity_countries": {
                  Row: {
                    "country": string,"entity": string
                  }
                  ComputedFields: never
                  Insert: {
                    "country": string,"entity": string
                  }
                  Update: {
                    "country"?: string,"entity"?: string
                  }
                  Relationships: [
                    
                  ]
                },"cty_load": {
                  Row: {
                    "entities": number,"id": boolean,"loaded_at": string,"prefixes": number,"version": string | null
                  }
                  ComputedFields: never
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
                  ComputedFields: never
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
                    "attempts": number,"created_at": string,"destination_id": string,"dropped_at": string | null,"id": number,"last_error": string | null,"last_failed_at": string | null,"sent_at": string | null,"spot_id": number,"status": string,"subscription_id": string,"url_generation": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"destination_id": string,"dropped_at"?: string | null,"id"?: number,"last_error"?: string | null,"last_failed_at"?: string | null,"sent_at"?: string | null,"spot_id": number,"status"?: string,"subscription_id": string,"url_generation"?: number | null
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"destination_id"?: string,"dropped_at"?: string | null,"id"?: number,"last_error"?: string | null,"last_failed_at"?: string | null,"sent_at"?: string | null,"spot_id"?: number,"status"?: string,"subscription_id"?: string,"url_generation"?: number | null
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
                    "auto_disabled_at": string | null,"claim_due_at": string,"claim_tokens": number,"claim_tokens_at": string,"consecutive_failures": number,"created_at": string,"enabled": boolean,"health": string,"id": string,"last_error": string | null,"last_error_at": string | null,"last_success_at": string | null,"name": string,"pause_failure_at": string | null,"pause_failures": number,"secret_rotated_at": string | null,"signing_secret": string | null,"throttle_level": number,"throttled_until": string | null,"type": string,"url": string | null,"url_display": string,"url_generation": number,"user_id": string,"api_destination_json": Json | null
                  }
                  ComputedFields: "api_destination_json"
                  Insert: {
                    "auto_disabled_at"?: string | null,"claim_due_at"?: string,"claim_tokens"?: number,"claim_tokens_at"?: string,"consecutive_failures"?: number,"created_at"?: string,"enabled"?: boolean,"health"?: string,"id"?: string,"last_error"?: string | null,"last_error_at"?: string | null,"last_success_at"?: string | null,"name": string,"pause_failure_at"?: string | null,"pause_failures"?: number,"secret_rotated_at"?: string | null,"signing_secret"?: string | null,"throttle_level"?: number,"throttled_until"?: string | null,"type": string,"url"?: string | null,"url_display": string,"url_generation"?: number,"user_id": string
                  }
                  Update: {
                    "auto_disabled_at"?: string | null,"claim_due_at"?: string,"claim_tokens"?: number,"claim_tokens_at"?: string,"consecutive_failures"?: number,"created_at"?: string,"enabled"?: boolean,"health"?: string,"id"?: string,"last_error"?: string | null,"last_error_at"?: string | null,"last_success_at"?: string | null,"name"?: string,"pause_failure_at"?: string | null,"pause_failures"?: number,"secret_rotated_at"?: string | null,"signing_secret"?: string | null,"throttle_level"?: number,"throttled_until"?: string | null,"type"?: string,"url"?: string | null,"url_display"?: string,"url_generation"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"discord_destination_settings": {
                  Row: {
                    "batch_seconds": number,"bold_first": boolean,"card_color": string,"destination_id": string,"detail_fields": (string)[],"footer": boolean,"grid_fields": (string)[],"line_fields": (string)[],"link_preview": string,"separator": string,"show_field_names": boolean,"style": string,"title_fields": (string)[],"title_link": string,"validate_discord_settings": undefined | null
                  }
                  ComputedFields: "validate_discord_settings"
                  Insert: {
                    "batch_seconds": number,"bold_first": boolean,"card_color": string,"destination_id": string,"detail_fields": (string)[],"footer": boolean,"grid_fields": (string)[],"line_fields": (string)[],"link_preview": string,"separator": string,"show_field_names": boolean,"style": string,"title_fields": (string)[],"title_link": string
                  }
                  Update: {
                    "batch_seconds"?: number,"bold_first"?: boolean,"card_color"?: string,"destination_id"?: string,"detail_fields"?: (string)[],"footer"?: boolean,"grid_fields"?: (string)[],"line_fields"?: (string)[],"link_preview"?: string,"separator"?: string,"show_field_names"?: boolean,"style"?: string,"title_fields"?: (string)[],"title_link"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "discord_destination_settings_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: true
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    }
                  ]
                },"fcc_uls_am": {
                  Row: {
                    "operator_class": string | null,"usi": number
                  }
                  ComputedFields: never
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
                    "first_name": string | null,"last_name": string | null,"name": string | null,"state": string | null,"usi": number
                  }
                  ComputedFields: never
                  Insert: {
                    "first_name"?: string | null,"last_name"?: string | null,"name"?: string | null,"state"?: string | null,"usi": number
                  }
                  Update: {
                    "first_name"?: string | null,"last_name"?: string | null,"name"?: string | null,"state"?: string | null,"usi"?: number
                  }
                  Relationships: [
                    
                  ]
                },"fcc_uls_hd": {
                  Row: {
                    "callsign": string,"expires_on": string | null,"granted_on": string | null,"status": string | null,"usi": number
                  }
                  ComputedFields: never
                  Insert: {
                    "callsign": string,"expires_on"?: string | null,"granted_on"?: string | null,"status"?: string | null,"usi": number
                  }
                  Update: {
                    "callsign"?: string,"expires_on"?: string | null,"granted_on"?: string | null,"status"?: string | null,"usi"?: number
                  }
                  Relationships: [
                    
                  ]
                },"goal_entries": {
                  Row: {
                    "contact_spot_id": number | null,"hand_needed_at": string | null,"matched_spot_id": number | null,"position": number,"requirement_id": string,"value": string,"worked_at": string | null,"worked_how": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "contact_spot_id"?: number | null,"hand_needed_at"?: string | null,"matched_spot_id"?: number | null,"position": number,"requirement_id": string,"value": string,"worked_at"?: string | null,"worked_how"?: string | null
                  }
                  Update: {
                    "contact_spot_id"?: number | null,"hand_needed_at"?: string | null,"matched_spot_id"?: number | null,"position"?: number,"requirement_id"?: string,"value"?: string,"worked_at"?: string | null,"worked_how"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "goal_entries_contact_spot_id_fkey"
      columns: ["contact_spot_id"]
isOneToOne: false
      referencedRelation: "raw_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_entries_contact_spot_id_fkey"
      columns: ["contact_spot_id"]
isOneToOne: false
      referencedRelation: "recent_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_entries_matched_spot_id_fkey"
      columns: ["matched_spot_id"]
isOneToOne: false
      referencedRelation: "raw_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_entries_matched_spot_id_fkey"
      columns: ["matched_spot_id"]
isOneToOne: false
      referencedRelation: "recent_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_entries_requirement_id_fkey"
      columns: ["requirement_id"]
isOneToOne: false
      referencedRelation: "goal_requirements"
      referencedColumns: ["id"]
    }
                  ]
                },"goal_requirements": {
                  Row: {
                    "at_least": number | null,"complete_when": string,"id": string,"kind": string,"list_id": string,"position": number
                  }
                  ComputedFields: never
                  Insert: {
                    "at_least"?: number | null,"complete_when": string,"id"?: string,"kind": string,"list_id": string,"position": number
                  }
                  Update: {
                    "at_least"?: number | null,"complete_when"?: string,"id"?: string,"kind"?: string,"list_id"?: string,"position"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "goal_requirements_list_id_fkey"
      columns: ["list_id"]
isOneToOne: false
      referencedRelation: "goals"
      referencedColumns: ["id"]
    }
                  ]
                },"goal_reviews": {
                  Row: {
                    "candidates": (string)[],"contact_spot_id": number,"created_at": string,"id": string,"list_id": string,"picked_reference": string | null,"resolved_at": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidates"?: (string)[],"contact_spot_id": number,"created_at"?: string,"id"?: string,"list_id": string,"picked_reference"?: string | null,"resolved_at"?: string | null,"status"?: string
                  }
                  Update: {
                    "candidates"?: (string)[],"contact_spot_id"?: number,"created_at"?: string,"id"?: string,"list_id"?: string,"picked_reference"?: string | null,"resolved_at"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "goal_reviews_contact_spot_id_fkey"
      columns: ["contact_spot_id"]
isOneToOne: false
      referencedRelation: "raw_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_reviews_contact_spot_id_fkey"
      columns: ["contact_spot_id"]
isOneToOne: false
      referencedRelation: "recent_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_reviews_list_id_fkey"
      columns: ["list_id"]
isOneToOne: false
      referencedRelation: "goals"
      referencedColumns: ["id"]
    }
                  ]
                },"goals": {
                  Row: {
                    "completed_at": string | null,"created_at": string,"ends_on": string | null,"id": string,"marking": string,"name": string,"starts_on": string | null,"updated_at": string,"user_id": string,"goal_card": Json | null,"goal_status": string | null
                  }
                  ComputedFields: "goal_card" | "goal_status"
                  Insert: {
                    "completed_at"?: string | null,"created_at"?: string,"ends_on"?: string | null,"id"?: string,"marking"?: string,"name": string,"starts_on"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "completed_at"?: string | null,"created_at"?: string,"ends_on"?: string | null,"id"?: string,"marking"?: string,"name"?: string,"starts_on"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"group_stats_cache": {
                  Row: {
                    "generated_at": string,"group_id": string,"payload": NonNullable<Json>,"period": string,"roster": string
                  }
                  ComputedFields: never
                  Insert: {
                    "generated_at"?: string,"group_id": string,"payload": NonNullable<Json>,"period": string,"roster": string
                  }
                  Update: {
                    "generated_at"?: string,"group_id"?: string,"payload"?: NonNullable<Json>,"period"?: string,"roster"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "group_stats_cache_group_id_fkey"
      columns: ["group_id"]
isOneToOne: false
      referencedRelation: "callsign_groups"
      referencedColumns: ["id"]
    }
                  ]
                },"health_cache": {
                  Row: {
                    "generated_at": string,"payload": NonNullable<Json>,"range": string
                  }
                  ComputedFields: never
                  Insert: {
                    "generated_at": string,"payload": NonNullable<Json>,"range": string
                  }
                  Update: {
                    "generated_at"?: string,"payload"?: NonNullable<Json>,"range"?: string
                  }
                  Relationships: [
                    
                  ]
                },"health_samples": {
                  Row: {
                    "db_bytes": number,"db_connections": number,"delivery_oldest_ready_seconds": number | null,"delivery_waiting": number,"match_oldest_seconds": number | null,"match_waiting": number,"sampled_at": string,"spots_total": NonNullable<Json>,"throttled_destinations": number
                  }
                  ComputedFields: never
                  Insert: {
                    "db_bytes": number,"db_connections": number,"delivery_oldest_ready_seconds"?: number | null,"delivery_waiting": number,"match_oldest_seconds"?: number | null,"match_waiting": number,"sampled_at": string,"spots_total": NonNullable<Json>,"throttled_destinations": number
                  }
                  Update: {
                    "db_bytes"?: number,"db_connections"?: number,"delivery_oldest_ready_seconds"?: number | null,"delivery_waiting"?: number,"match_oldest_seconds"?: number | null,"match_waiting"?: number,"sampled_at"?: string,"spots_total"?: NonNullable<Json>,"throttled_destinations"?: number
                  }
                  Relationships: [
                    
                  ]
                },"hidden_callsigns": {
                  Row: {
                    "callsign": string,"hidden_at": string,"note": string | null
                  }
                  ComputedFields: never
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
                    "error": string,"id": number,"last_seen_at": string,"occurred_at": string,"occurrences": number,"payload_hash": string | null,"raw_payload": NonNullable<Json>,"source": string
                  }
                  ComputedFields: never
                  Insert: {
                    "error": string,"id"?: number,"last_seen_at"?: string,"occurred_at"?: string,"occurrences"?: number,"payload_hash"?: never,"raw_payload": NonNullable<Json>,"source": string
                  }
                  Update: {
                    "error"?: string,"id"?: number,"last_seen_at"?: string,"occurred_at"?: string,"occurrences"?: number,"payload_hash"?: never,"raw_payload"?: NonNullable<Json>,"source"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ingest_state": {
                  Row: {
                    "consecutive_failures": number,"last_epoch": string | null,"last_error": string | null,"last_error_at": string | null,"last_run_at": string | null,"last_success_at": string | null,"source": string,"total_runs": number,"total_spots_ingested": number
                  }
                  ComputedFields: never
                  Insert: {
                    "consecutive_failures"?: number,"last_epoch"?: string | null,"last_error"?: string | null,"last_error_at"?: string | null,"last_run_at"?: string | null,"last_success_at"?: string | null,"source": string,"total_runs"?: number,"total_spots_ingested"?: number
                  }
                  Update: {
                    "consecutive_failures"?: number,"last_epoch"?: string | null,"last_error"?: string | null,"last_error_at"?: string | null,"last_run_at"?: string | null,"last_success_at"?: string | null,"source"?: string,"total_runs"?: number,"total_spots_ingested"?: number
                  }
                  Relationships: [
                    
                  ]
                },"iota_groups": {
                  Row: {
                    "name": string,"refno": string
                  }
                  ComputedFields: never
                  Insert: {
                    "name": string,"refno": string
                  }
                  Update: {
                    "name"?: string,"refno"?: string
                  }
                  Relationships: [
                    
                  ]
                },"iota_load": {
                  Row: {
                    "groups": number,"id": boolean,"loaded_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "groups": number,"id"?: boolean,"loaded_at": string
                  }
                  Update: {
                    "groups"?: number,"id"?: boolean,"loaded_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"license_loads": {
                  Row: {
                    "applied_at": string | null,"authority": string,"counts": Json | null,"error": string | null,"id": number,"licenses": number | null,"ready_at": string | null,"started_at": string,"status": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applied_at"?: string | null,"authority": string,"counts"?: Json | null,"error"?: string | null,"id"?: never,"licenses"?: number | null,"ready_at"?: string | null,"started_at"?: string,"status"?: string,"version": string
                  }
                  Update: {
                    "applied_at"?: string | null,"authority"?: string,"counts"?: Json | null,"error"?: string | null,"id"?: never,"licenses"?: number | null,"ready_at"?: string | null,"started_at"?: string,"status"?: string,"version"?: string
                  }
                  Relationships: [
                    
                  ]
                },"local_cluster_destination_settings": {
                  Row: {
                    "destination_id": string,"fields": (string)[],"relay_token_id": string | null,"local_cluster_settings_json": Json | null
                  }
                  ComputedFields: "local_cluster_settings_json"
                  Insert: {
                    "destination_id": string,"fields": (string)[],"relay_token_id"?: string | null
                  }
                  Update: {
                    "destination_id"?: string,"fields"?: (string)[],"relay_token_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "local_cluster_destination_settings_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: true
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "local_cluster_destination_settings_relay_token_id_fkey"
      columns: ["relay_token_id"]
isOneToOne: false
      referencedRelation: "relay_tokens"
      referencedColumns: ["id"]
    }
                  ]
                },"logged_contacts": {
                  Row: {
                    "content_hash": string,"created_at": string,"external_id": string,"gridsquare": string | null,"logger_app": string | null,"relay_version": string | null,"retracted_at": string | null,"spot_id": number,"state": string,"updated_at": string,"us_state": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content_hash": string,"created_at"?: string,"external_id": string,"gridsquare"?: string | null,"logger_app"?: string | null,"relay_version"?: string | null,"retracted_at"?: string | null,"spot_id": number,"state": string,"updated_at"?: string,"us_state"?: string | null,"user_id": string
                  }
                  Update: {
                    "content_hash"?: string,"created_at"?: string,"external_id"?: string,"gridsquare"?: string | null,"logger_app"?: string | null,"relay_version"?: string | null,"retracted_at"?: string | null,"spot_id"?: number,"state"?: string,"updated_at"?: string,"us_state"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "logged_contacts_spot_id_fkey"
      columns: ["spot_id"]
isOneToOne: false
      referencedRelation: "raw_spots"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "logged_contacts_spot_id_fkey"
      columns: ["spot_id"]
isOneToOne: false
      referencedRelation: "recent_spots"
      referencedColumns: ["id"]
    }
                  ]
                },"lookup_rate_limits": {
                  Row: {
                    "client": string,"lookups": number,"window_start": string
                  }
                  ComputedFields: never
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
                    "callsign": string,"callsign_since": string,"created_at": string,"id": string,"name": string,"timezone": string,"utc_times": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "callsign": string,"callsign_since"?: string,"created_at"?: string,"id": string,"name"?: string,"timezone"?: string,"utc_times"?: boolean
                  }
                  Update: {
                    "callsign"?: string,"callsign_since"?: string,"created_at"?: string,"id"?: string,"name"?: string,"timezone"?: string,"utc_times"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"push_destination_devices": {
                  Row: {
                    "destination_id": string,"device_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "destination_id": string,"device_id": string
                  }
                  Update: {
                    "destination_id"?: string,"device_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_destination_devices_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: false
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "push_destination_devices_device_id_fkey"
      columns: ["device_id"]
isOneToOne: false
      referencedRelation: "push_devices"
      referencedColumns: ["id"]
    }
                  ]
                },"push_destination_settings": {
                  Row: {
                    "action_buttons": boolean,"body_fields": (string)[],"body_separator": string,"destination_id": string,"quiet_enabled": boolean,"quiet_from": string,"quiet_mode": string,"quiet_until": string,"replace_same_station": boolean,"show_field_names": boolean,"sound": boolean,"tap_target": string,"title_fields": (string)[],"ttl_seconds": number,"urgency": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action_buttons": boolean,"body_fields": (string)[],"body_separator": string,"destination_id": string,"quiet_enabled": boolean,"quiet_from": string,"quiet_mode": string,"quiet_until": string,"replace_same_station": boolean,"show_field_names": boolean,"sound": boolean,"tap_target": string,"title_fields": (string)[],"ttl_seconds": number,"urgency": string
                  }
                  Update: {
                    "action_buttons"?: boolean,"body_fields"?: (string)[],"body_separator"?: string,"destination_id"?: string,"quiet_enabled"?: boolean,"quiet_from"?: string,"quiet_mode"?: string,"quiet_until"?: string,"replace_same_station"?: boolean,"show_field_names"?: boolean,"sound"?: boolean,"tap_target"?: string,"title_fields"?: (string)[],"ttl_seconds"?: number,"urgency"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_destination_settings_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: true
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    }
                  ]
                },"push_devices": {
                  Row: {
                    "agent": string,"auth": string,"blocked_at": string | null,"created_at": string,"endpoint": string,"id": string,"label": string,"last_error": string | null,"last_error_at": string | null,"last_success_at": string | null,"p256dh": string,"standalone": boolean,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent"?: string,"auth": string,"blocked_at"?: string | null,"created_at"?: string,"endpoint": string,"id"?: string,"label": string,"last_error"?: string | null,"last_error_at"?: string | null,"last_success_at"?: string | null,"p256dh": string,"standalone"?: boolean,"user_id": string
                  }
                  Update: {
                    "agent"?: string,"auth"?: string,"blocked_at"?: string | null,"created_at"?: string,"endpoint"?: string,"id"?: string,"label"?: string,"last_error"?: string | null,"last_error_at"?: string | null,"last_success_at"?: string | null,"p256dh"?: string,"standalone"?: boolean,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"raw_spots": {
                  Row: {
                    "band": string | null,"base_callsign": string | null,"callsign": string,"comment": string,"content_hash": string,"frequency_khz": number,"id": number,"ingested_at": string,"iota_reference": string | null,"iota_reference_name": string | null,"mode": string | null,"mode_family": string | null,"pota_location": string | null,"pota_park_name": string | null,"pota_reference": string | null,"raw_payload": NonNullable<Json>,"retracted_at": string | null,"sota_summit_ref": string | null,"source": string,"source_spot_id": string,"spot_time": string,"spotter": string | null,"wwbota_reference_name": string | null,"wwbota_references": (string)[] | null,"wwff_reference": string | null,"wwff_reference_name": string | null,"delivery_spot_json": Json | null,"goal_spot_values": {
              "kind": string,"value": string
            } | null,"spot_us_states": (string)[] | null
                  }
                  ComputedFields: "delivery_spot_json" | "goal_spot_values" | "spot_us_states"
                  Insert: {
                    "band"?: string | null,"base_callsign"?: never,"callsign": string,"comment"?: string,"content_hash": string,"frequency_khz": number,"id"?: number,"ingested_at"?: string,"iota_reference"?: string | null,"iota_reference_name"?: string | null,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"raw_payload": NonNullable<Json>,"retracted_at"?: string | null,"sota_summit_ref"?: string | null,"source": string,"source_spot_id": string,"spot_time": string,"spotter"?: string | null,"wwbota_reference_name"?: string | null,"wwbota_references"?: (string)[] | null,"wwff_reference"?: string | null,"wwff_reference_name"?: string | null
                  }
                  Update: {
                    "band"?: string | null,"base_callsign"?: never,"callsign"?: string,"comment"?: string,"content_hash"?: string,"frequency_khz"?: number,"id"?: number,"ingested_at"?: string,"iota_reference"?: string | null,"iota_reference_name"?: string | null,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"raw_payload"?: NonNullable<Json>,"retracted_at"?: string | null,"sota_summit_ref"?: string | null,"source"?: string,"source_spot_id"?: string,"spot_time"?: string,"spotter"?: string | null,"wwbota_reference_name"?: string | null,"wwbota_references"?: (string)[] | null,"wwff_reference"?: string | null,"wwff_reference_name"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"rbn_daily_skimmers": {
                  Row: {
                    "band": string | null,"day": string,"spots": number,"spotter": string
                  }
                  ComputedFields: never
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
                    "callsign": string,"day": string,"spots": number,"spotters": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "callsign": string,"day": string,"spots": number,"spotters"?: (string)[]
                  }
                  Update: {
                    "callsign"?: string,"day"?: string,"spots"?: number,"spotters"?: (string)[]
                  }
                  Relationships: [
                    
                  ]
                },"rbn_hourly": {
                  Row: {
                    "hour": string,"spots": number
                  }
                  ComputedFields: never
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
                  ComputedFields: never
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
                  ComputedFields: never
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
                  ComputedFields: never
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
                  ComputedFields: never
                  Insert: {
                    "callsign": string,"skimmers": number,"spots": number,"window_start": string
                  }
                  Update: {
                    "callsign"?: string,"skimmers"?: number,"spots"?: number,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reference_catalog": {
                  Row: {
                    "active": boolean,"altitude_m": number | null,"country": string | null,"grid": string | null,"latitude": number | null,"location": string | null,"longitude": number | null,"name": string | null,"points": number | null,"program": string,"reference": string,"region": string | null,"valid_from": string | null,"valid_to": string | null,"reference_catalog_header": Json | null
                  }
                  ComputedFields: "reference_catalog_header"
                  Insert: {
                    "active": boolean,"altitude_m"?: number | null,"country"?: string | null,"grid"?: string | null,"latitude"?: number | null,"location"?: string | null,"longitude"?: number | null,"name"?: string | null,"points"?: number | null,"program": string,"reference": string,"region"?: string | null,"valid_from"?: string | null,"valid_to"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"altitude_m"?: number | null,"country"?: string | null,"grid"?: string | null,"latitude"?: number | null,"location"?: string | null,"longitude"?: number | null,"name"?: string | null,"points"?: number | null,"program"?: string,"reference"?: string,"region"?: string | null,"valid_from"?: string | null,"valid_to"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"reference_catalog_loads": {
                  Row: {
                    "applied_at": string | null,"error": string | null,"finished_at": string | null,"id": number,"program": string,"staged_rows": number,"started_at": string,"state": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applied_at"?: string | null,"error"?: string | null,"finished_at"?: string | null,"id"?: never,"program": string,"staged_rows"?: number,"started_at"?: string,"state"?: string,"version": string
                  }
                  Update: {
                    "applied_at"?: string | null,"error"?: string | null,"finished_at"?: string | null,"id"?: never,"program"?: string,"staged_rows"?: number,"started_at"?: string,"state"?: string,"version"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reference_catalog_stage": {
                  Row: {
                    "active": boolean,"altitude_m": number | null,"country": string | null,"grid": string | null,"latitude": number | null,"load_id": number,"location": string | null,"longitude": number | null,"name": string | null,"points": number | null,"program": string,"reference": string,"region": string | null,"valid_from": string | null,"valid_to": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "active": boolean,"altitude_m"?: number | null,"country"?: string | null,"grid"?: string | null,"latitude"?: number | null,"load_id": number,"location"?: string | null,"longitude"?: number | null,"name"?: string | null,"points"?: number | null,"program": string,"reference": string,"region"?: string | null,"valid_from"?: string | null,"valid_to"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"altitude_m"?: number | null,"country"?: string | null,"grid"?: string | null,"latitude"?: number | null,"load_id"?: number,"location"?: string | null,"longitude"?: number | null,"name"?: string | null,"points"?: number | null,"program"?: string,"reference"?: string,"region"?: string | null,"valid_from"?: string | null,"valid_to"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "reference_catalog_stage_load_id_fkey"
      columns: ["load_id"]
isOneToOne: false
      referencedRelation: "reference_catalog_loads"
      referencedColumns: ["id"]
    }
                  ]
                },"reference_days": {
                  Row: {
                    "bands": (string)[],"base": string,"day": string,"modes": (string)[],"program": string,"reference": string,"source": string,"spots": number
                  }
                  ComputedFields: never
                  Insert: {
                    "bands": (string)[],"base": string,"day": string,"modes": (string)[],"program": string,"reference": string,"source": string,"spots": number
                  }
                  Update: {
                    "bands"?: (string)[],"base"?: string,"day"?: string,"modes"?: (string)[],"program"?: string,"reference"?: string,"source"?: string,"spots"?: number
                  }
                  Relationships: [
                    
                  ]
                },"reference_profile_cache": {
                  Row: {
                    "generated_at": string,"payload": NonNullable<Json>,"program": string,"reference": string
                  }
                  ComputedFields: never
                  Insert: {
                    "generated_at": string,"payload": NonNullable<Json>,"program": string,"reference": string
                  }
                  Update: {
                    "generated_at"?: string,"payload"?: NonNullable<Json>,"program"?: string,"reference"?: string
                  }
                  Relationships: [
                    
                  ]
                },"relay_pairings": {
                  Row: {
                    "answered_at": string | null,"client_version": string,"created_at": string,"device_code_hash": string,"device_name": string,"expires_at": string,"id": string,"interval_seconds": number,"last_polled_at": string | null,"platform": string | null,"scopes": (string)[],"status": string,"user_code": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "answered_at"?: string | null,"client_version": string,"created_at"?: string,"device_code_hash": string,"device_name": string,"expires_at"?: string,"id"?: string,"interval_seconds"?: number,"last_polled_at"?: string | null,"platform"?: string | null,"scopes"?: (string)[],"status"?: string,"user_code": string,"user_id"?: string | null
                  }
                  Update: {
                    "answered_at"?: string | null,"client_version"?: string,"created_at"?: string,"device_code_hash"?: string,"device_name"?: string,"expires_at"?: string,"id"?: string,"interval_seconds"?: number,"last_polled_at"?: string | null,"platform"?: string | null,"scopes"?: (string)[],"status"?: string,"user_code"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"relay_tokens": {
                  Row: {
                    "client_version": string,"cluster_connected_at": string | null,"contacts_window_count": number,"contacts_window_start": string | null,"created_at": string,"device_name": string,"id": string,"last_used_at": string | null,"platform": string | null,"scopes": (string)[],"token_hash": string,"token_prefix": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_version": string,"cluster_connected_at"?: string | null,"contacts_window_count"?: number,"contacts_window_start"?: string | null,"created_at"?: string,"device_name": string,"id"?: string,"last_used_at"?: string | null,"platform"?: string | null,"scopes": (string)[],"token_hash": string,"token_prefix": string,"user_id": string
                  }
                  Update: {
                    "client_version"?: string,"cluster_connected_at"?: string | null,"contacts_window_count"?: number,"contacts_window_start"?: string | null,"created_at"?: string,"device_name"?: string,"id"?: string,"last_used_at"?: string | null,"platform"?: string | null,"scopes"?: (string)[],"token_hash"?: string,"token_prefix"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"send_test_limits": {
                  Row: {
                    "destination_id": string,"tests": number,"user_id": string,"window_start": string
                  }
                  ComputedFields: never
                  Insert: {
                    "destination_id": string,"tests": number,"user_id": string,"window_start": string
                  }
                  Update: {
                    "destination_id"?: string,"tests"?: number,"user_id"?: string,"window_start"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "send_test_limits_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: false
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    }
                  ]
                },"sign_in_attempts": {
                  Row: {
                    "attempted_at": string,"client": string,"id": number,"identifier": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempted_at"?: string,"client": string,"id"?: number,"identifier": string
                  }
                  Update: {
                    "attempted_at"?: string,"client"?: string,"id"?: number,"identifier"?: string
                  }
                  Relationships: [
                    
                  ]
                },"stats_snapshots": {
                  Row: {
                    "generated_at": string,"id": number,"payload": NonNullable<Json>,"window_end": string,"window_start": string
                  }
                  ComputedFields: never
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
                  ComputedFields: never
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
                  ComputedFields: never
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
                    "created_at": string,"enabled": boolean,"group_ids": (string)[],"id": string,"name": string,"quiet_minutes": number,"rules": NonNullable<Json>,"sources": (string)[],"updated_at": string,"user_id": string,"api_subscription_json": Json | null
                  }
                  ComputedFields: "api_subscription_json"
                  Insert: {
                    "created_at"?: string,"enabled"?: boolean,"group_ids"?: (string)[],"id"?: string,"name": string,"quiet_minutes"?: number,"rules"?: NonNullable<Json>,"sources"?: (string)[],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"enabled"?: boolean,"group_ids"?: (string)[],"id"?: string,"name"?: string,"quiet_minutes"?: number,"rules"?: NonNullable<Json>,"sources"?: (string)[],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"webhook_destination_headers": {
                  Row: {
                    "destination_id": string,"id": string,"name": string,"position": number,"secret_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "destination_id": string,"id"?: string,"name": string,"position": number,"secret_id": string
                  }
                  Update: {
                    "destination_id"?: string,"id"?: string,"name"?: string,"position"?: number,"secret_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "webhook_destination_headers_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: false
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    }
                  ]
                },"webhook_destination_settings": {
                  Row: {
                    "batch_seconds": number,"destination_id": string,"fields": (string)[],"frequency_unit": string,"key_style": string,"missing_values": string,"pause_after_failures": number | null,"retry_policy": string,"time_format": string,"validate_webhook_settings": undefined | null
                  }
                  ComputedFields: "validate_webhook_settings"
                  Insert: {
                    "batch_seconds": number,"destination_id": string,"fields": (string)[],"frequency_unit": string,"key_style": string,"missing_values": string,"pause_after_failures"?: number | null,"retry_policy": string,"time_format": string
                  }
                  Update: {
                    "batch_seconds"?: number,"destination_id"?: string,"fields"?: (string)[],"frequency_unit"?: string,"key_style"?: string,"missing_values"?: string,"pause_after_failures"?: number | null,"retry_policy"?: string,"time_format"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "webhook_destination_settings_destination_id_fkey"
      columns: ["destination_id"]
isOneToOne: true
      referencedRelation: "destinations"
      referencedColumns: ["id"]
    }
                  ]
                },"worker_heartbeats": {
                  Row: {
                    "feeds": Json | null,"id": number,"last_progress_at": string | null,"received_at": string,"reconnects": number | null,"rss_bytes": number,"started_at": string,"worker": string
                  }
                  ComputedFields: never
                  Insert: {
                    "feeds"?: Json | null,"id"?: number,"last_progress_at"?: string | null,"received_at"?: string,"reconnects"?: number | null,"rss_bytes": number,"started_at": string,"worker": string
                  }
                  Update: {
                    "feeds"?: Json | null,"id"?: number,"last_progress_at"?: string | null,"received_at"?: string,"reconnects"?: number | null,"rss_bytes"?: number,"started_at"?: string,"worker"?: string
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
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"callsign_rollup_status": {
                  Row: {
                    "attempts": number | null,"day": string | null,"days_filled_at": string | null,"last_error": string | null,"last_failed_at": string | null,"references_filled_at": string | null,"rolled_at": string | null,"spots": number | null,"status": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"ingest_health": {
                  Row: {
                    "consecutive_failures": number | null,"last_error": string | null,"last_run_at": string | null,"last_success_at": string | null,"seconds_since_last_success": number | null,"source": string | null,"spots_last_24h": number | null,"spots_last_hour": number | null,"total_spots_ingested": number | null
                  }
                  ComputedFields: never
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
                    "band": string | null,"callsign": string | null,"comment": string | null,"frequency_khz": number | null,"id": number | null,"iota_reference": string | null,"iota_reference_name": string | null,"mode": string | null,"mode_family": string | null,"pota_location": string | null,"pota_park_name": string | null,"pota_reference": string | null,"sota_summit_ref": string | null,"source": string | null,"spot_time": string | null,"spotter": string | null,"wwbota_reference_name": string | null,"wwbota_references": (string)[] | null,"wwff_reference": string | null,"wwff_reference_name": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "band"?: string | null,"callsign"?: string | null,"comment"?: string | null,"frequency_khz"?: number | null,"id"?: number | null,"iota_reference"?: string | null,"iota_reference_name"?: string | null,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"sota_summit_ref"?: string | null,"source"?: string | null,"spot_time"?: string | null,"spotter"?: string | null,"wwbota_reference_name"?: string | null,"wwbota_references"?: (string)[] | null,"wwff_reference"?: string | null,"wwff_reference_name"?: string | null
                         }
                        Update: {
                           "band"?: string | null,"callsign"?: string | null,"comment"?: string | null,"frequency_khz"?: number | null,"id"?: number | null,"iota_reference"?: string | null,"iota_reference_name"?: string | null,"mode"?: string | null,"mode_family"?: string | null,"pota_location"?: string | null,"pota_park_name"?: string | null,"pota_reference"?: string | null,"sota_summit_ref"?: string | null,"source"?: string | null,"spot_time"?: string | null,"spotter"?: string | null,"wwbota_reference_name"?: string | null,"wwbota_references"?: (string)[] | null,"wwff_reference"?: string | null,"wwff_reference_name"?: string | null
                         }
                        Relationships: [
                    
                  ]
                },"spot_stream": {
                  Row: {
                    "band": string | null,"base_callsign": string | null,"callsign": string | null,"comment": string | null,"frequency_khz": number | null,"mode": string | null,"mode_bucket": string | null,"program": string | null,"reference": string | null,"reference_location": string | null,"reference_name": string | null,"snr": number | null,"source": string | null,"spot_time": string | null,"spotter": string | null,"spotter_base": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "abandon_reference_load":
{ Args: { "p_error": string,"p_load": number }; Returns: undefined
                           },
"answer_relay_pairing":
{ Args: { "p_approve": boolean,"p_user_code": string }; Returns: Json
                           },
"api_call":
{ Args: { "p_args": Json,"p_op": string,"p_token_id": string }; Returns: Json
                           },
"api_destination_json":
{ Args: { "d": Omit<Database["public"]['Tables']["destinations"]['Row'], Database["public"]['Tables']["destinations"]['ComputedFields']> }; Returns: Json
                           },
"api_group_json":
{ Args: { "g": Json }; Returns: Json
                           },
"api_subscription_json":
{ Args: { "s": Omit<Database["public"]['Tables']["subscriptions"]['Row'], Database["public"]['Tables']["subscriptions"]['ComputedFields']> }; Returns: Json
                           },
"app_site_url":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"apply_license_loads":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"apply_logged_contacts":
{ Args: { "p_items": Json,"p_user_id": string }; Returns: Json
                           },
"apply_reference_loads":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"aprs_day_archived":
{ Args: { "p_day": string }; Returns: boolean
                           },
"aprs_day_slices":
{ Args: { "p_day": string }; Returns: {
              "archived_rows": number,"db_rows": number,"slice_start": string
            }[]
                           },
"archive_columns":
{ Args: { "p_from": string,"p_source": string,"p_to": string }; Returns: {
              "columns": Json,"row_count": number
            }[]
                           },
"archive_ndjson_slices":
{ Args: { "p_after_source": string,"p_after_start": string,"p_limit": number }; Returns: {
              "object_path": string,"row_count": number,"slice_end": string,"slice_start": string,"source": string
            }[]
                           },
"archive_pending_slices":
{ Args: { "p_before": string,"p_limit": number,"p_source": string }; Returns: {
              "slice_end": string,"slice_start": string
            }[]
                           },
"archive_repoint_slice":
{ Args: { "p_bytes": number,"p_from_path": string,"p_row_count": number,"p_slice_start": string,"p_source": string,"p_to_path": string }; Returns: boolean
                           },
"archive_slice_minutes":
{ Args: { "p_source": string }; Returns: number
                           },
"authenticate_api_request":
{ Args: { "p_token_hash": string }; Returns: {
              "requests": number,"scope": string,"token_id": string,"user_id": string
            }[]
                           },
"authenticate_relay_token":
{ Args: { "p_token_hash": string }; Returns: {
              "scopes": (string)[],"token_id": string,"user_id": string
            }[]
                           },
"backfill_callsign_days":
{ Args: { "p_max_days"?: number }; Returns: {
              "error": string,"exact": boolean,"fill_day": string,"spots": number
            }[]
                           },
"backfill_callsign_rollups":
{ Args: { "p_max_days"?: number }; Returns: {
              "error": string,"rollup_day": string,"spots": number
            }[]
                           },
"backfill_reference_days":
{ Args: { "p_max_days"?: number }; Returns: {
              "error": string,"fill_day": string,"spots": number
            }[]
                           },
"band_map_snapshot":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"base_callsign":
{ Args: { "p_call": string }; Returns: string
                           },
"base64url_bytes":
{ Args: { "p_text": string }; Returns: string
                           },
"begin_reference_load":
{ Args: { "p_program": string,"p_version": string }; Returns: number
                           },
"begin_sign_in_attempt":
{ Args: { "p_client": string,"p_identifier": string }; Returns: number
                           },
"build_stats_snapshot_at":
{ Args: { "p_now": string }; Returns: undefined
                           },
"cached_band_map":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"cached_callsign_profile":
{ Args: { "p_callsign": string }; Returns: Json
                           },
"cached_group_statistics":
{ Args: { "p_build"?: boolean,"p_group_id": string,"p_max_age"?: string,"p_period": string }; Returns: Json
                           },
"cached_health":
{ Args: { "p_range": string }; Returns: Json
                           },
"cached_reference_profile":
{ Args: { "p_program": string,"p_reference": string }; Returns: Json
                           },
"callsign_group_rows":
{ Args: { "p_id": string }; Returns: {
              "callsigns": (string)[],"id": string,"member_count": number,"name": string,"on_air": Json,"subscription_count": number,"updated_at": string
            }[]
                           },
"callsign_matches":
{ Args: { "p_base": string,"p_call": string,"p_callsigns": (string)[] }; Returns: boolean
                           },
"callsign_profile":
{ Args: { "p_callsign": string }; Returns: Json
                           },
"check_discord_setting_keys":
{ Args: { "p_settings": Json }; Returns: undefined
                           },
"check_local_cluster_setting_keys":
{ Args: { "p_settings": Json }; Returns: undefined
                           },
"check_webhook_setting_keys":
{ Args: { "p_settings": Json }; Returns: undefined
                           },
"claim_deliveries":
{ Args: { "p_limit"?: number,"p_vt"?: number }; Returns: {
              "attempts": number,"created_at": string,"delivery_id": number,"destination": Json,"msg_id": number,"spot": Json,"subscription_id": string
            }[]
                           },
"compact_callsign_rollups":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"complete_profile":
{ Args: { "p_callsign": string,"p_name": string }; Returns: undefined
                           },
"copy_goal":
{ Args: { "p_id": string }; Returns: string
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
"cron_call_function":
{ Args: { "p_body"?: Json,"p_function": string,"p_job": string,"p_timeout_ms"?: number }; Returns: number
                           },
"cty_lookup":
{ Args: { "p_call": string }; Returns: {
              "continent": string,"cq_zone": number,"entity": string,"itu_zone": number,"name": string
            }[]
                           },
"delete_callsign_group":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_destination":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_goal":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_push_device":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_subscription":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delivery_queue_stats":
{ Args: Record<PropertyKey, never>; Returns: {
              "depth": number,"expired_last_hour": number
            }[]
                           },
"delivery_spot_json":
{ Args: { "r": Omit<Database["public"]['Tables']["raw_spots"]['Row'], Database["public"]['Tables']["raw_spots"]['ComputedFields']> }; Returns: Json
                           },
"destination_batch_full":
{ Args: { "p_type": string }; Returns: number
                           },
"destination_budget":
{ Args: { "p_type": string }; Returns: {
              "burst": number,"rate_per_minute": number
            }[]
                           },
"destination_claim_interval":
{ Args: { "p_type": string }; Returns: string
                           },
"destination_claim_max":
{ Args: { "p_type": string }; Returns: number
                           },
"destination_max_age":
{ Args: { "p_type": string }; Returns: string
                           },
"destination_throttle_seconds":
{ Args: { "p_level": number }; Returns: number
                           },
"destination_url_display":
{ Args: { "p_type": string,"p_url": string }; Returns: string
                           },
"discord_clip":
{ Args: { "p_max": number,"p_text": string }; Returns: string
                           },
"discord_color":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["discord_destination_settings"]['Row'], Database["public"]['Tables']["discord_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: number
                           },
"discord_default_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"discord_escape":
{ Args: { "p_text": string }; Returns: string
                           },
"discord_field_values":
{ Args: { "p_spot": Json }; Returns: Json
                           },
"discord_fields":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"discord_fields_valid":
{ Args: { "p_fields": (string)[],"p_max": number,"p_min": number }; Returns: boolean
                           },
"discord_footer":
{ Args: { "p_spot": Json }; Returns: string
                           },
"discord_grid":
{ Args: { "p_fields": (string)[],"p_values": Json }; Returns: Json
                           },
"discord_join":
{ Args: { "p_fields": (string)[],"p_labels": boolean,"p_separator": string,"p_values": Json }; Returns: string
                           },
"discord_plain_line":
{ Args: { "p_max"?: number,"p_settings": Omit<Database["public"]['Tables']["discord_destination_settings"]['Row'], Database["public"]['Tables']["discord_destination_settings"]['ComputedFields']>,"p_spot": Json,"p_values": Json }; Returns: string
                           },
"discord_profile_url":
{ Args: { "p_spot": Json }; Returns: string
                           },
"discord_source_color":
{ Args: { "p_source": string }; Returns: number
                           },
"discord_spot_fields":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["discord_destination_settings"]['Row'], Database["public"]['Tables']["discord_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: Json
                           },
"discord_test_delivery":
{ Args: { "p_destination_id": string,"p_spot_id"?: number }; Returns: Json
                           },
"discord_title_url":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["discord_destination_settings"]['Row'], Database["public"]['Tables']["discord_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: string
                           },
"duplicate_destination":
{ Args: { "p_id": string }; Returns: string
                           },
"edit_group_callsigns":
{ Args: { "p_add": Json,"p_id": string,"p_remove": Json }; Returns: undefined
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
"fill_callsign_days":
{ Args: { "p_day": string }; Returns: {
              "exact": boolean,"spots": number
            }[]
                           },
"fill_reference_days":
{ Args: { "p_day": string }; Returns: number
                           },
"finish_reference_load":
{ Args: { "p_load": number,"p_rows": number }; Returns: string
                           },
"first_rollup_day":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"forget_sign_in_attempt":
{ Args: { "p_attempt_id": number }; Returns: undefined
                           },
"get_discord_destination":
{ Args: { "p_id": string }; Returns: Json
                           },
"get_goal":
{ Args: { "p_id": string }; Returns: Json
                           },
"get_group_statistics":
{ Args: { "p_id": string,"p_period": string }; Returns: Json
                           },
"get_local_cluster_destination":
{ Args: { "p_id": string }; Returns: Json
                           },
"get_push_destination":
{ Args: { "p_id": string }; Returns: Json
                           },
"get_webhook_destination":
{ Args: { "p_id": string }; Returns: Json
                           },
"goal_apply_contact":
{ Args: { "p_spot_id": number,"p_user": string }; Returns: undefined
                           },
"goal_bands":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"goal_card":
{ Args: { "p": Omit<Database["public"]['Tables']["goals"]['Row'], Database["public"]['Tables']["goals"]['ComputedFields']> }; Returns: Json
                           },
"goal_contact_facts":
{ Args: { "p_spot_id": number,"p_user": string }; Returns: {
              "band": string,"candidates": (string)[],"license_state": string,"park": string,"park_spot_id": number,"pick_state": boolean,"pota_that_day": boolean,"spot_id": number,"spot_time": string,"state": string,"state_spot_id": number,"worked_base": string
            }[]
                           },
"goal_date":
{ Args: { "p_value": string }; Returns: string
                           },
"goal_entry_value":
{ Args: { "p_kind": string,"p_value": string }; Returns: string
                           },
"goal_mark":
{ Args: { "p_lists": (string)[],"p_spot_id": number,"p_user": string }; Returns: undefined
                           },
"goal_matches":
{ Args: { "p_list_id": string,"spot": Omit<Database["public"]['Tables']["raw_spots"]['Row'], Database["public"]['Tables']["raw_spots"]['ComputedFields']> }; Returns: boolean
                           },
"goal_park_state":
{ Args: { "p_license": string,"p_location": string }; Returns: string
                           },
"goal_picked_location":
{ Args: { "p_base": string,"p_reference": string,"p_time": string }; Returns: string
                           },
"goal_recheck":
{ Args: { "p_list_id": string }; Returns: undefined
                           },
"goal_refresh_completion":
{ Args: { "p_list_id": string }; Returns: undefined
                           },
"goal_requirement_complete":
{ Args: { "p_requirement_id": string }; Returns: boolean
                           },
"goal_requirement_progress":
{ Args: { "p_list_id": string }; Returns: {
              "at_least": number,"complete": boolean,"complete_when": string,"entries": number,"id": string,"kind": string,"position": number,"target": number,"worked": number
            }[]
                           },
"goal_skips_worked":
{ Args: { "p_list_id": string,"spot": Omit<Database["public"]['Tables']["raw_spots"]['Row'], Database["public"]['Tables']["raw_spots"]['ComputedFields']> }; Returns: boolean
                           },
"goal_spot_values":
{ Args: { "spot": Omit<Database["public"]['Tables']["raw_spots"]['Row'], Database["public"]['Tables']["raw_spots"]['ComputedFields']> }; Returns: {
              "kind": string,"value": string
            }[]
                           },
"goal_status":
{ Args: { "p": Omit<Database["public"]['Tables']["goals"]['Row'], Database["public"]['Tables']["goals"]['ComputedFields']> }; Returns: string
                           },
"goal_sync_reviews":
{ Args: { "p_lists": (string)[],"p_spot_id": number,"p_user": string }; Returns: undefined
                           },
"goals_for_spot":
{ Args: { "p_spot_id": number }; Returns: (string)[]
                           },
"group_matches":
{ Args: { "p_base": string,"p_group_ids": (string)[] }; Returns: boolean
                           },
"group_member_bases":
{ Args: { "p_group_id": string }; Returns: (string)[]
                           },
"group_statistics":
{ Args: { "p_group_id": string,"p_period": string }; Returns: Json
                           },
"group_statistics_at":
{ Args: { "p_group_id": string,"p_now": string,"p_period": string }; Returns: Json
                           },
"group_stats_redact":
{ Args: { "p": Json }; Returns: Json
                           },
"group_stats_roster":
{ Args: { "p_bases": (string)[] }; Returns: string
                           },
"health_disk_limit_bytes":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"health_oldest_ready_seconds":
{ Args: { "p_now": string }; Returns: number
                           },
"health_snapshot":
{ Args: { "p_range": string }; Returns: Json
                           },
"health_worker_memory_bytes":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"home_flow":
{ Args: Record<PropertyKey, never>; Returns: Json
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
"insert_relay_pairing":
{ Args: { "p_client_version": string,"p_device_name": string,"p_platform": string,"p_scopes": (string)[] }; Returns: Json
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
"list_discord_destination_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_goals":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_group_summaries":
{ Args: Record<PropertyKey, never>; Returns: {
              "daily": (number)[],"id": string,"member_count": number,"members_heard": number,"on_air": (string)[],"public": boolean,"spots": number
            }[]
                           },
"list_ingest_health":
{ Args: Record<PropertyKey, never>; Returns: {
              "consecutive_failures": number,"last_error": string,"last_run_at": string,"last_success_at": string,"seconds_since_last_success": number,"source": string
            }[]
                           },
"list_local_cluster_destination_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"list_push_devices":
{ Args: { "p_current_endpoint"?: string }; Returns: {
              "agent": string,"blocked_at": string,"created_at": string,"destination_ids": (string)[],"id": string,"is_current": boolean,"label": string,"last_error": string,"last_error_at": string,"last_success_at": string,"standalone": boolean
            }[]
                           },
"list_recent_spots":
{ Args: { "max_rows": number,"p_source": string }; Returns: {
              "band": string | null,
"callsign": string | null,
"comment": string | null,
"frequency_khz": number | null,
"id": number | null,
"iota_reference": string | null,
"iota_reference_name": string | null,
"mode": string | null,
"mode_family": string | null,
"pota_location": string | null,
"pota_park_name": string | null,
"pota_reference": string | null,
"sota_summit_ref": string | null,
"source": string | null,
"spot_time": string | null,
"spotter": string | null,
"wwbota_reference_name": string | null,
"wwbota_references": (string)[] | null,
"wwff_reference": string | null,
"wwff_reference_name": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "recent_spots"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_webhook_destination_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"load_cty":
{ Args: { "p_entities": Json,"p_prefixes": Json,"p_version": string }; Returns: undefined
                           },
"load_iota_groups":
{ Args: { "p_groups": Json }; Returns: number
                           },
"local_cluster_comment":
{ Args: { "p_fields": (string)[],"p_spot": Json }; Returns: string
                           },
"local_cluster_default_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"local_cluster_fields":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"local_cluster_fields_valid":
{ Args: { "p_fields": (string)[] }; Returns: boolean
                           },
"local_cluster_line":
{ Args: { "p_callsign": string,"p_comment": string,"p_frequency_khz": number,"p_spotter": string,"p_time": string }; Returns: string
                           },
"local_cluster_mode_word":
{ Args: { "p_frequency_khz": number,"p_mode": string }; Returns: string
                           },
"local_cluster_reference":
{ Args: { "p_spot": Json }; Returns: string
                           },
"local_cluster_relay_cap":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"local_cluster_sample_spot":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"local_cluster_settings_json":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["local_cluster_destination_settings"]['Row'], Database["public"]['Tables']["local_cluster_destination_settings"]['ComputedFields']> }; Returns: Json
                           },
"local_cluster_settings_record":
{ Args: { "p_destination_id": string,"p_settings": Json }; Returns: {
              "destination_id": string,
"fields": (string)[],
"relay_token_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "local_cluster_destination_settings"
        isOneToOne: true
        isSetofReturn: false
      } },
"local_cluster_spot_fields":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["local_cluster_destination_settings"]['Row'], Database["public"]['Tables']["local_cluster_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: Json
                           },
"local_cluster_station":
{ Args: { "p_text": string }; Returns: string
                           },
"log_archive":
{ Args: { "p_bytes": number,"p_object_path": string,"p_row_count": number,"p_slice_end": string,"p_slice_start": string,"p_source": string }; Returns: undefined
                           },
"lookup_relay_pairing":
{ Args: { "p_user_code": string }; Returns: Json
                           },
"maintain_aprs_packets":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"maintain_rbn_spots":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"mark_deliveries_failed":
{ Args: { "p_delay_seconds": number,"p_delivery_ids": (number)[],"p_error": string,"p_msg_ids": (number)[] }; Returns: undefined
                           },
"mark_deliveries_sent":
{ Args: { "p_delivery_ids": (number)[],"p_msg_ids": (number)[] }; Returns: undefined
                           },
"mark_goal_entry":
{ Args: { "p_requirement_id": string,"p_value": string,"p_worked": boolean }; Returns: undefined
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
"new_group_slug":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"new_relay_token":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"new_relay_user_code":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"normalize_group_callsigns":
{ Args: { "p_calls": (string)[] }; Returns: Json
                           },
"normalize_subscription_rules":
{ Args: { "p_rules": Json,"p_strict": boolean,"p_user": string }; Returns: Json
                           },
"normalize_subscription_sources":
{ Args: { "p_sources": Json }; Returns: (string)[]
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
"poll_relay_pairing":
{ Args: { "p_device_code_hash": string }; Returns: Json
                           },
"preview_discord_message":
{ Args: { "p_settings": Json,"p_spot_id"?: number }; Returns: Json
                           },
"preview_goal_window":
{ Args: { "p_ends_on": string,"p_id": string,"p_marking": string,"p_starts_on": string }; Returns: Json
                           },
"preview_local_cluster_line":
{ Args: { "p_settings": Json,"p_spot_id"?: number }; Returns: Json
                           },
"preview_push_notification":
{ Args: { "p_body_fields": (string)[],"p_body_separator": string,"p_show_field_names": boolean,"p_spot_id"?: number,"p_title_fields": (string)[] }; Returns: {
              "body": string,"source_url": string,"title": string,"url": string
            }[]
                           },
"preview_subscription":
{ Args: { "filter": Json }; Returns: {
              "count": number,"skipped_worked": number,"spots": Json,"station_count": number,"window_size": number
            }[]
                           },
"preview_webhook_request":
{ Args: { "p_destination_id"?: string,"p_settings": Json,"p_spot_id"?: number }; Returns: Json
                           },
"profile_cache_ttl":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"prune_callsign_lookups":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"prune_push_devices":
{ Args: { "p_endpoints": (string)[] }; Returns: number
                           },
"prune_relay_pairings":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"public_group_statistics":
{ Args: { "p_period": string,"p_slug": string }; Returns: Json
                           },
"push_clip":
{ Args: { "p_max": number,"p_text": string }; Returns: string
                           },
"push_default_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"push_field_label":
{ Args: { "p_field": string }; Returns: string
                           },
"push_fields":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"push_fields_valid":
{ Args: { "p_fields": (string)[],"p_max": number,"p_min": number }; Returns: boolean
                           },
"push_member_devices":
{ Args: { "p_destination_id": string }; Returns: Json
                           },
"push_profile_url":
{ Args: { "p_spot": Json }; Returns: string
                           },
"push_quiet_now":
{ Args: { "p_at": string,"p_settings": Omit<Database["public"]['Tables']["push_destination_settings"]['Row'], Database["public"]['Tables']["push_destination_settings"]['ComputedFields']>,"p_timezone": string }; Returns: boolean
                           },
"push_sample_spot":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"push_separator":
{ Args: { "p_separator": string }; Returns: string
                           },
"push_source_label":
{ Args: { "p_source": string }; Returns: string
                           },
"push_spot_fields":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["push_destination_settings"]['Row'], Database["public"]['Tables']["push_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: Json
                           },
"push_test_delivery":
{ Args: { "p_destination_id": string,"p_spot_id"?: number }; Returns: Json
                           },
"rbn_day_archived":
{ Args: { "p_day": string }; Returns: boolean
                           },
"rbn_day_archived_rows":
{ Args: { "p_day": string }; Returns: number
                           },
"rbn_day_retired":
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
"record_callsign_rollup_failure":
{ Args: { "p_day": string,"p_error": string }; Returns: undefined
                           },
"record_health_sample":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"record_inbound_heartbeat":
{ Args: { "p_feeds": Json,"p_reconnects": number,"p_rss_bytes": number,"p_started_at": string }; Returns: undefined
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
"record_push_results":
{ Args: { "p_errors": Json,"p_ok": (string)[] }; Returns: undefined
                           },
"record_relay_contacts":
{ Args: { "p_count": number,"p_token_id": string }; Returns: number
                           },
"record_send_test":
{ Args: { "p_destination_id": string,"p_user_id": string }; Returns: boolean
                           },
"record_sender_heartbeat":
{ Args: { "p_last_progress_at": string,"p_rss_bytes": number,"p_started_at": string }; Returns: undefined
                           },
"reference_catalog_header":
{ Args: { "c": Omit<Database["public"]['Tables']["reference_catalog"]['Row'], Database["public"]['Tables']["reference_catalog"]['ComputedFields']> }; Returns: Json
                           },
"reference_load_floor":
{ Args: { "p_program": string }; Returns: number
                           },
"reference_load_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"reference_profile":
{ Args: { "p_program": string,"p_reference": string }; Returns: Json
                           },
"refresh_stats_rollups":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"refresh_stats_rollups_at":
{ Args: { "p_now": string }; Returns: undefined
                           } |
{ Args: { "p_max_aprs_days": number,"p_max_country_days": number,"p_max_rbn_days": number,"p_now": string }; Returns: undefined
                           },
"refresh_stats_snapshot":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"refresh_stats_snapshot_at":
{ Args: { "p_now": string }; Returns: undefined
                           },
"register_push_device":
{ Args: { "p_agent"?: string,"p_auth": string,"p_endpoint": string,"p_label": string,"p_p256dh": string,"p_previous_endpoint"?: string,"p_standalone"?: boolean }; Returns: string
                           },
"relay_account":
{ Args: { "p_user_id": string }; Returns: Json
                           } |
{ Args: { "p_token_id": string,"p_user_id": string }; Returns: Json
                           },
"relay_contacts_per_minute":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"relay_scopes":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"relay_tokens_max":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"relay_user_code":
{ Args: { "p_text": string }; Returns: string
                           },
"rename_duplicate_destination_names":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"rename_push_device":
{ Args: { "p_id": string,"p_label": string }; Returns: undefined
                           },
"render_push_field":
{ Args: { "p_field": string,"p_spot": Json }; Returns: string
                           },
"render_push_fields":
{ Args: { "p_fields": (string)[],"p_labels": boolean,"p_separator": string,"p_spot": Json }; Returns: string
                           },
"report_push_device_blocked":
{ Args: { "p_endpoint": string }; Returns: undefined
                           },
"reset_cluster_streams":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"resolve_goal_review":
{ Args: { "p_id": string,"p_reference": string }; Returns: undefined
                           },
"retire_aprs_day":
{ Args: { "p_day": string }; Returns: undefined
                           },
"retire_rbn_day":
{ Args: { "p_day": string }; Returns: undefined
                           },
"rollup_aprs_day":
{ Args: { "p_day": string }; Returns: boolean
                           },
"rollup_callsign_day":
{ Args: { "p_day": string,"p_without_rbn"?: boolean }; Returns: number
                           },
"rollup_country_day":
{ Args: { "p_day": string }; Returns: boolean
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
"rule_matches":
{ Args: { "p_rule": Json,"spot": Omit<Database["public"]['Tables']["raw_spots"]['Row'], Database["public"]['Tables']["raw_spots"]['ComputedFields']> }; Returns: boolean
                           },
"rules_goal_ids":
{ Args: { "p_rules": Json }; Returns: (string)[]
                           },
"rules_name_stations":
{ Args: { "p_rules": Json }; Returns: boolean
                           },
"run_housekeeping":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"save_callsign_group":
{ Args: { "payload": Json }; Returns: string
                           },
"save_discord_destination":
{ Args: { "p_enabled": boolean,"p_id": string,"p_name": string,"p_settings": Json,"p_url": string }; Returns: string
                           },
"save_goal":
{ Args: { "payload": Json }; Returns: string
                           },
"save_local_cluster_destination":
{ Args: { "p_enabled": boolean,"p_id": string,"p_name": string,"p_settings": Json }; Returns: string
                           },
"save_push_destination":
{ Args: { "p_device_ids": (string)[],"p_enabled": boolean,"p_id": string,"p_name": string,"p_settings": Json }; Returns: string
                           },
"save_subscription":
{ Args: { "payload": Json }; Returns: string
                           },
"save_webhook_destination":
{ Args: { "p_enabled": boolean,"p_headers": Json,"p_id": string,"p_name": string,"p_settings": Json,"p_url": string }; Returns: {
              "id": string,"signing_secret": string
            }[]
                           },
"search_references":
{ Args: { "p_program": string,"p_query": string }; Returns: Json
                           },
"search_references_at":
{ Args: { "p_grouped_from": number,"p_program": string,"p_query": string }; Returns: Json
                           },
"send_test_account_limit":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"send_test_destination_limit":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"set_cluster_stream":
{ Args: { "p_connected": boolean,"p_token_id": string }; Returns: Json
                           },
"set_webhook_headers":
{ Args: { "p_destination_id": string,"p_headers": Json }; Returns: undefined
                           },
"source_matches":
{ Args: { "p_source": string,"p_sources": (string)[] }; Returns: boolean
                           },
"spot_license_name":
{ Args: { "p_part": string,"p_spot": Json }; Returns: string
                           },
"spot_matches":
{ Args: { "spot": Omit<Database["public"]['Tables']["raw_spots"]['Row'], Database["public"]['Tables']["raw_spots"]['ComputedFields']>,"sub": Omit<Database["public"]['Tables']["subscriptions"]['Row'], Database["public"]['Tables']["subscriptions"]['ComputedFields']> }; Returns: boolean
                           },
"spot_source_url":
{ Args: { "p_spot": Json }; Returns: string
                           },
"spot_us_states":
{ Args: { "spot": Omit<Database["public"]['Tables']["raw_spots"]['Row'], Database["public"]['Tables']["raw_spots"]['ComputedFields']> }; Returns: (string)[]
                           },
"stage_reference_rows":
{ Args: { "p_load": number,"p_rows": Json }; Returns: number
                           },
"start_relay_pairing":
{ Args: { "p_client_version": string,"p_device_name": string }; Returns: Json
                           } |
{ Args: { "p_client_version": string,"p_device_name": string,"p_platform": string,"p_scopes": (string)[] }; Returns: Json
                           },
"stats_payload_without_hidden":
{ Args: { "p_payload": Json }; Returns: Json
                           },
"subscription_quiet_minutes":
{ Args: Record<PropertyKey, never>; Returns: (number)[]
                           },
"subscription_quiet_minutes_text":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"throttle_destination":
{ Args: { "p_destination_id": string,"p_msg_ids": (number)[],"p_seconds": number }; Returns: number
                           },
"unique_destination_name":
{ Args: { "p_name": string,"p_user": string }; Returns: string
                           },
"unregister_push_device":
{ Args: { "p_endpoint": string }; Returns: undefined
                           },
"update_destination":
{ Args: { "p_enabled"?: boolean,"p_id": string,"p_name": string,"p_url": string }; Returns: undefined
                           },
"us_states":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"validate_destination_url":
{ Args: { "p_type": string,"p_url": string }; Returns: undefined
                           },
"validate_discord_fields":
{ Args: { "p_fields": (string)[],"p_what": string }; Returns: undefined
                           },
"validate_discord_settings":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["discord_destination_settings"]['Row'], Database["public"]['Tables']["discord_destination_settings"]['ComputedFields']> }; Returns: undefined
                           },
"validate_local_cluster_fields":
{ Args: { "p_fields": (string)[] }; Returns: undefined
                           },
"validate_local_cluster_settings":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["local_cluster_destination_settings"]['Row'], Database["public"]['Tables']["local_cluster_destination_settings"]['ComputedFields']>,"p_user": string }; Returns: undefined
                           },
"validate_push_endpoint":
{ Args: { "p_endpoint": string }; Returns: undefined
                           },
"validate_push_fields":
{ Args: { "p_fields": (string)[],"p_what": string }; Returns: undefined
                           },
"validate_webhook_fields":
{ Args: { "p_fields": (string)[] }; Returns: undefined
                           },
"validate_webhook_settings":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["webhook_destination_settings"]['Row'], Database["public"]['Tables']["webhook_destination_settings"]['ComputedFields']> }; Returns: undefined
                           },
"watched_among":
{ Args: { "p_callsigns": (string)[],"p_source": string }; Returns: string[]
                           },
"webhook_claim_max":
{ Args: { "p_batch_seconds": number }; Returns: number
                           },
"webhook_default_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"webhook_field_key":
{ Args: { "p_field": string,"p_frequency_unit": string,"p_key_style": string }; Returns: string
                           },
"webhook_field_value":
{ Args: { "p_field": string,"p_frequency_unit": string,"p_spot": Json,"p_time_format": string }; Returns: Json
                           },
"webhook_fields":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"webhook_fields_valid":
{ Args: { "p_fields": (string)[] }; Returns: boolean
                           },
"webhook_header_name_valid":
{ Args: { "p_name": string }; Returns: boolean
                           },
"webhook_header_names":
{ Args: { "p_destination_id": string }; Returns: Json
                           },
"webhook_header_secret":
{ Args: { "p_value": string }; Returns: string
                           },
"webhook_header_values":
{ Args: { "p_destination_id": string }; Returns: Json
                           },
"webhook_legacy_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"webhook_pause_spacing":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"webhook_request_body":
{ Args: { "p_connection": string,"p_delivery_id": number,"p_settings": Omit<Database["public"]['Tables']["webhook_destination_settings"]['Row'], Database["public"]['Tables']["webhook_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: Json
                           },
"webhook_retries_exhausted":
{ Args: { "p_attempts": number,"p_policy": string }; Returns: boolean
                           },
"webhook_retry_delay":
{ Args: { "p_attempt": number,"p_policy": string }; Returns: number
                           },
"webhook_retry_max_attempts":
{ Args: { "p_policy": string }; Returns: number
                           },
"webhook_spot_fields":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["webhook_destination_settings"]['Row'], Database["public"]['Tables']["webhook_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: Json
                           },
"webhook_spot_object":
{ Args: { "p_settings": Omit<Database["public"]['Tables']["webhook_destination_settings"]['Row'], Database["public"]['Tables']["webhook_destination_settings"]['ComputedFields']>,"p_spot": Json }; Returns: Json
                           },
"webhook_test_delivery":
{ Args: { "p_destination_id": string,"p_spot_id"?: number }; Returns: Json
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

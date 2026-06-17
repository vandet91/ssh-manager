--
-- PostgreSQL database dump
--

\restrict ZOrwKaSt7B4D5sWOdRyhCQBqIlVXQhyeFDg6Lx4xBXShFkw4DdOhHV3LwlhfDdF

-- Dumped from database version 15.18
-- Dumped by pg_dump version 15.18

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    user_id uuid,
    user_email character varying(255),
    action character varying(100) NOT NULL,
    resource character varying(100),
    resource_id uuid,
    server_id uuid,
    details jsonb DEFAULT '{}'::jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.audit_logs OWNER TO sshmanager;

--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: sshmanager
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.audit_logs_id_seq OWNER TO sshmanager;

--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: sshmanager
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: key_assignments; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.key_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    key_id uuid NOT NULL,
    server_id uuid NOT NULL,
    linux_user character varying(100) NOT NULL,
    can_terminal boolean DEFAULT true,
    is_active boolean DEFAULT true,
    expires_at timestamp with time zone,
    granted_by uuid,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.key_assignments OWNER TO sshmanager;

--
-- Name: kysely_migration; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.kysely_migration (
    name character varying(255) NOT NULL,
    "timestamp" character varying(255) NOT NULL
);


ALTER TABLE public.kysely_migration OWNER TO sshmanager;

--
-- Name: kysely_migration_lock; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.kysely_migration_lock (
    id character varying(255) NOT NULL,
    is_locked integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.kysely_migration_lock OWNER TO sshmanager;

--
-- Name: rotation_jobs; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.rotation_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key_id uuid,
    status character varying(20) DEFAULT 'pending'::character varying,
    triggered_by uuid,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_message text,
    affected_servers jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT rotation_jobs_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'success'::character varying, 'failed'::character varying, 'rolled_back'::character varying])::text[])))
);


ALTER TABLE public.rotation_jobs OWNER TO sshmanager;

--
-- Name: security_scans; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.security_scans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid,
    scanned_at timestamp with time zone DEFAULT now(),
    findings jsonb DEFAULT '[]'::jsonb,
    severity character varying(10),
    scan_type character varying(50),
    CONSTRAINT security_scans_severity_check CHECK (((severity)::text = ANY ((ARRAY['ok'::character varying, 'low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);


ALTER TABLE public.security_scans OWNER TO sshmanager;

--
-- Name: server_credentials; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.server_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    linux_user character varying(100),
    label character varying(200) NOT NULL,
    password_enc text NOT NULL,
    notes text,
    created_by uuid,
    last_revealed_at timestamp with time zone,
    last_changed_on_server_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    archived_reason character varying(50),
    predecessor_id uuid,
    category character varying(50) DEFAULT 'linux'::character varying NOT NULL,
    service_name character varying(100),
    service_username character varying(100)
);


ALTER TABLE public.server_credentials OWNER TO sshmanager;

--
-- Name: servers; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    hostname character varying(255) NOT NULL,
    ssh_port integer DEFAULT 22 NOT NULL,
    environment character varying(20) NOT NULL,
    tags jsonb DEFAULT '{}'::jsonb,
    host_key_fingerprint character varying(200),
    host_key_verified boolean DEFAULT false,
    host_key_last_seen timestamp with time zone,
    management_key_id uuid,
    management_linux_user character varying(100) DEFAULT 'root'::character varying NOT NULL,
    is_active boolean DEFAULT true,
    last_connected_at timestamp with time zone,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    os_type character varying(20) DEFAULT 'linux'::character varying,
    host_type character varying(50) DEFAULT NULL::character varying,
    host_type_detail character varying(200) DEFAULT NULL::character varying,
    CONSTRAINT servers_environment_check CHECK (((environment)::text = ANY ((ARRAY['production'::character varying, 'staging'::character varying, 'development'::character varying, 'other'::character varying])::text[])))
);


ALTER TABLE public.servers OWNER TO sshmanager;

--
-- Name: session_recordings; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.session_recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    server_id uuid,
    linux_user character varying(100),
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    duration_s integer,
    cast_file_path text,
    cast_size_bytes integer,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.session_recordings OWNER TO sshmanager;

--
-- Name: settings; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.settings OWNER TO sshmanager;

--
-- Name: ssh_keys; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.ssh_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    key_type character varying(10) DEFAULT 'ed25519'::character varying NOT NULL,
    public_key text NOT NULL,
    private_key_enc text NOT NULL,
    fingerprint character varying(200) NOT NULL,
    rotation_policy character varying(20) DEFAULT 'manual'::character varying,
    last_rotated_at timestamp with time zone,
    next_rotation_at timestamp with time zone,
    is_active boolean DEFAULT true,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    archived_at timestamp with time zone,
    archive_reason character varying(20),
    archived_by uuid,
    purge_after timestamp with time zone,
    successor_key_id uuid,
    predecessor_key_id uuid,
    CONSTRAINT ssh_keys_archive_reason_check CHECK (((archive_reason)::text = ANY ((ARRAY['rotated'::character varying, 'deleted'::character varying, 'reverted'::character varying])::text[]))),
    CONSTRAINT ssh_keys_rotation_policy_check CHECK (((rotation_policy)::text = ANY ((ARRAY['manual'::character varying, '7d'::character varying, '30d'::character varying, '90d'::character varying, '180d'::character varying, '365d'::character varying])::text[]))),
    CONSTRAINT ssh_keys_type_check CHECK (((key_type)::text = ANY ((ARRAY['ed25519'::character varying, 'rsa4096'::character varying])::text[])))
);


ALTER TABLE public.ssh_keys OWNER TO sshmanager;

--
-- Name: users; Type: TABLE; Schema: public; Owner: sshmanager
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    display_name character varying(255),
    provider character varying(20),
    provider_id character varying(255),
    provider_groups jsonb DEFAULT '[]'::jsonb,
    role character varying(20) DEFAULT 'viewer'::character varying NOT NULL,
    mfa_secret text,
    mfa_enabled boolean DEFAULT false,
    mfa_backup_codes jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    password_hash text,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    password_changed_at timestamp with time zone,
    CONSTRAINT users_provider_check CHECK (((provider)::text = ANY ((ARRAY['microsoft'::character varying, 'google'::character varying, 'local'::character varying])::text[]))),
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'operator'::character varying, 'developer'::character varying, 'viewer'::character varying])::text[])))
);


ALTER TABLE public.users OWNER TO sshmanager;

--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.audit_logs (id, user_id, user_email, action, resource, resource_id, server_id, details, ip_address, user_agent, created_at) FROM stdin;
177	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:05:23.679908+00
178	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:13:02.620258+00
179	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:13:11.78393+00
180	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	key.private_downloaded	ssh_key	67c5570f-d26b-4bdf-b073-99dd2c059b8b	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:13:34.073144+00
181	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	key.private_downloaded	ssh_key	67c5570f-d26b-4bdf-b073-99dd2c059b8b	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:14:28.358789+00
182	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:23:21.820308+00
183	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	key.private_downloaded	ssh_key	67c5570f-d26b-4bdf-b073-99dd2c059b8b	\N	{"format": "openssh"}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:23:53.170635+00
184	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	key.private_downloaded	ssh_key	9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	\N	{"format": "ppk"}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:25:34.610675+00
185	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:32:37.664376+00
186	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:43:27.138703+00
187	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:45:23.561148+00
188	d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	auth.login.success	\N	\N	\N	{}	172.18.0.6	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36	2026-06-14 13:49:23.442502+00
\.


--
-- Data for Name: key_assignments; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.key_assignments (id, user_id, key_id, server_id, linux_user, can_terminal, is_active, expires_at, granted_by, created_at) FROM stdin;
845f0b7c-5695-4c7b-acd3-92ca3a63f305	d2921614-c65d-4759-9cdf-f38ef3bff16c	ea701fb1-1901-4291-96f7-172d15ddf878	bc754abc-53be-4b71-9911-6bd2a26079c2	vandet	t	t	\N	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 00:14:09.188996+00
46b59f66-adb3-4225-9a4e-e978320aa713	d2921614-c65d-4759-9cdf-f38ef3bff16c	9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	bc754abc-53be-4b71-9911-6bd2a26079c2	root	t	t	\N	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 14:04:05.622663+00
1e3b2a40-332d-481f-a1eb-0fc9b41474a0	d2921614-c65d-4759-9cdf-f38ef3bff16c	24bfeefb-7ca9-4600-a611-45566500e2f4	bc754abc-53be-4b71-9911-6bd2a26079c2	vandet	t	f	\N	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 14:27:49.330157+00
7e56aaf2-8418-4e65-9013-0f0f4dbbb10a	d2921614-c65d-4759-9cdf-f38ef3bff16c	24bfeefb-7ca9-4600-a611-45566500e2f4	bc754abc-53be-4b71-9911-6bd2a26079c2	root	t	t	\N	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 14:28:57.080583+00
e9ecce93-e3cc-4453-b6f3-eca9e7b91355	d2921614-c65d-4759-9cdf-f38ef3bff16c	9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	ea0bdf3b-ea62-49fe-983a-fa6440a43ae9	root	t	t	\N	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 09:13:05.371041+00
\.


--
-- Data for Name: kysely_migration; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.kysely_migration (name, "timestamp") FROM stdin;
001_initial	2026-06-13T12:15:21.852Z
002_local_auth	2026-06-13T12:26:23.616Z
003_key_archive	2026-06-13T15:17:46.159Z
004_server_credentials	2026-06-14T00:38:01.073Z
005_credential_archive	2026-06-14T02:17:46.347Z
006_credential_categories	2026-06-14T02:30:35.245Z
007_settings	2026-06-14T06:05:22.975Z
008_telegram	2026-06-14T07:35:35.092Z
009_alert_settings	2026-06-14T09:37:55.847Z
010_os_type	2026-06-14T12:32:23.870Z
011_host_type	2026-06-14T12:48:33.097Z
012_rotation_policy	2026-06-14T13:45:29.958Z
\.


--
-- Data for Name: kysely_migration_lock; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.kysely_migration_lock (id, is_locked) FROM stdin;
migration_lock	0
\.


--
-- Data for Name: rotation_jobs; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.rotation_jobs (id, key_id, status, triggered_by, started_at, completed_at, error_message, affected_servers, created_at) FROM stdin;
2721c96b-5751-4a09-9e96-61f529f14451	67c5570f-d26b-4bdf-b073-99dd2c059b8b	success	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 14:38:17.211+00	2026-06-13 14:38:17.235+00	\N	[]	2026-06-13 14:38:17.212279+00
4ec58c79-54e7-4bfe-8e76-b40cc2f08e9e	2c0598f9-189c-48e8-8fd0-3f97ff5ce3b4	rolled_back	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 00:27:48.915+00	2026-06-14 00:27:49.125+00	bc754abc-53be-4b71-9911-6bd2a26079c2/root: All configured authentication methods failed	[{"error": "All configured authentication methods failed", "status": "failed", "server_id": "bc754abc-53be-4b71-9911-6bd2a26079c2", "linux_user": "root"}]	2026-06-14 00:27:48.916407+00
161b33b2-93c1-45fe-99c2-1d8b4efcba2b	9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	success	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 00:39:09.118+00	2026-06-14 00:39:10.605+00	\N	[{"status": "success", "server_id": "bc754abc-53be-4b71-9911-6bd2a26079c2", "linux_user": "root"}]	2026-06-14 00:39:09.119552+00
07e2b12f-e9ee-4384-9b98-05594c8de19e	24bfeefb-7ca9-4600-a611-45566500e2f4	success	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 00:39:53.425+00	2026-06-14 00:39:55.109+00	\N	[{"status": "success", "server_id": "bc754abc-53be-4b71-9911-6bd2a26079c2", "linux_user": "root"}]	2026-06-14 00:39:53.4266+00
3a74639d-998e-458e-95f3-ebe1b44f2181	\N	success	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 13:40:53.203+00	2026-06-13 13:40:53.221+00	\N	[]	2026-06-13 13:40:53.2044+00
5851bd72-1a4b-4603-9f01-5b7c53e669b9	\N	success	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 13:45:10.835+00	2026-06-13 13:45:10.848+00	\N	[]	2026-06-13 13:45:10.836541+00
\.


--
-- Data for Name: security_scans; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.security_scans (id, server_id, scanned_at, findings, severity, scan_type) FROM stdin;
992d833d-c7f2-459c-83db-76e496d1f662	bc754abc-53be-4b71-9911-6bd2a26079c2	2026-06-14 04:07:36.73012+00	[{"output": "passwordauthentication yes", "passed": false, "check_id": "password_auth", "severity": "high", "description": "Password authentication should be disabled"}, {"output": "permitrootlogin yes", "passed": false, "check_id": "root_login", "severity": "critical", "description": "Root login should be prohibited"}, {"output": "", "passed": true, "check_id": "ssh_protocol", "severity": "critical", "description": "Only SSH protocol 2 should be in use"}, {"output": "600", "passed": true, "check_id": "authorized_keys_permissions", "severity": "high", "description": "authorized_keys must not be world-readable (must be 600)"}, {"output": "2", "passed": true, "check_id": "stale_keys", "severity": "medium", "description": "authorized_keys should not contain unmanaged keys"}, {"output": "x11forwarding yes", "passed": false, "check_id": "x11_forwarding", "severity": "low", "description": "X11 forwarding should be disabled"}]	critical	standard
24ca7aa0-4149-4357-a4fb-9de650844e77	bc754abc-53be-4b71-9911-6bd2a26079c2	2026-06-14 04:31:50.956542+00	[{"output": "passwordauthentication yes", "passed": false, "check_id": "password_auth", "severity": "high", "description": "Password authentication should be disabled"}, {"output": "permitrootlogin yes", "passed": false, "check_id": "root_login", "severity": "critical", "description": "Root login should be prohibited"}, {"output": "", "passed": true, "check_id": "ssh_protocol", "severity": "critical", "description": "Only SSH protocol 2 should be in use"}, {"output": "600", "passed": true, "check_id": "authorized_keys_permissions", "severity": "high", "description": "authorized_keys must not be world-readable (must be 600)"}, {"output": "2", "passed": true, "check_id": "stale_keys", "severity": "medium", "description": "authorized_keys should not contain unmanaged keys"}, {"output": "x11forwarding yes", "passed": false, "check_id": "x11_forwarding", "severity": "low", "description": "X11 forwarding should be disabled"}]	critical	standard
e42116ad-6101-4a7b-8550-75f75c833446	bc754abc-53be-4b71-9911-6bd2a26079c2	2026-06-14 07:10:17.635708+00	[{"output": "passwordauthentication yes", "passed": false, "check_id": "password_auth", "severity": "high", "description": "Password authentication should be disabled"}, {"output": "permitrootlogin yes", "passed": false, "check_id": "root_login", "severity": "critical", "description": "Root login should be prohibited"}, {"output": "", "passed": true, "check_id": "ssh_protocol", "severity": "critical", "description": "Only SSH protocol 2 should be in use"}, {"output": "600", "passed": true, "check_id": "authorized_keys_permissions", "severity": "high", "description": "authorized_keys must not be world-readable (must be 600)"}, {"output": "2", "passed": true, "check_id": "stale_keys", "severity": "medium", "description": "authorized_keys should not contain unmanaged keys"}, {"output": "x11forwarding yes", "passed": false, "check_id": "x11_forwarding", "severity": "low", "description": "X11 forwarding should be disabled"}]	critical	standard
a2fa2ad3-00ad-45c4-b6ec-c07241f565d0	ea0bdf3b-ea62-49fe-983a-fa6440a43ae9	2026-06-14 09:14:09.735201+00	[{"output": "passwordauthentication yes", "passed": false, "check_id": "password_auth", "severity": "high", "description": "Password authentication should be disabled"}, {"output": "permitrootlogin yes", "passed": false, "check_id": "root_login", "severity": "critical", "description": "Root login should be prohibited"}, {"output": "", "passed": true, "check_id": "ssh_protocol", "severity": "critical", "description": "Only SSH protocol 2 should be in use"}, {"output": "600", "passed": true, "check_id": "authorized_keys_permissions", "severity": "high", "description": "authorized_keys must not be world-readable (must be 600)"}, {"output": "2", "passed": false, "check_id": "stale_keys", "severity": "medium", "description": "authorized_keys should not contain unmanaged keys"}, {"output": "x11forwarding yes", "passed": false, "check_id": "x11_forwarding", "severity": "low", "description": "X11 forwarding should be disabled"}]	critical	standard
\.


--
-- Data for Name: server_credentials; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.server_credentials (id, server_id, linux_user, label, password_enc, notes, created_by, last_revealed_at, last_changed_on_server_at, created_at, updated_at, is_archived, archived_at, archived_reason, predecessor_id, category, service_name, service_username) FROM stdin;
b566953e-7970-4785-908b-ff1fa4e16449	bc754abc-53be-4b71-9911-6bd2a26079c2	admin@yourcorp.com	root	3669ae28da32b4e52b5ff54b2dca11d3:f3c1e5c27d4defecc311334bb6322076:y8nbDGjdTu8=		d2921614-c65d-4759-9cdf-f38ef3bff16c	\N	2026-06-14 02:45:11.083+00	2026-06-14 02:32:49.706655+00	2026-06-14 06:21:52.152+00	t	2026-06-14 06:21:52.152+00	rotated	\N	linux		
3be37d15-3130-496e-b4cd-8865396ea1e2	bc754abc-53be-4b71-9911-6bd2a26079c2	admin@yourcorp.com	root	f1e33fb124592e925a27ea028495a16f:66baba9e857cfcf3635a70c4a2028fc3:sfeArlsSbKkO3g4iV2lTwOhrnZnlCo26		d2921614-c65d-4759-9cdf-f38ef3bff16c	\N	2026-06-14 06:21:52.158+00	2026-06-14 06:21:52.160669+00	2026-06-14 06:22:12.249+00	t	2026-06-14 06:22:12.249+00	deleted	b566953e-7970-4785-908b-ff1fa4e16449	linux		
87e85f94-948f-4718-8c56-2b8560960652	bc754abc-53be-4b71-9911-6bd2a26079c2	vandet	admin@yourcorp.com	d40d3d2d1ea338a3bb0dd727a283eeb3:32962fdc564486591b780643b52d7b8f:QODOxF7KNiaSJR3f		d2921614-c65d-4759-9cdf-f38ef3bff16c	\N	2026-06-14 06:21:37.16+00	2026-06-14 06:21:36.520466+00	2026-06-14 06:56:06.91+00	t	2026-06-14 06:56:06.91+00	rotated	\N	linux		
82e549b1-dacc-42bb-8769-6f7bcec3f8a9	bc754abc-53be-4b71-9911-6bd2a26079c2	vandet	admin@yourcorp.com	dfd42da54a1cf27be2333c3227a67e36:dbce081cc2f9265ba85c10a09dbe0086:yh/fWqjWtBCgDl6wQeyaPVz6WND1bfE3		d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 11:51:58.807+00	2026-06-14 06:56:06.918+00	2026-06-14 06:56:06.92017+00	2026-06-14 06:56:06.92017+00	f	\N	\N	87e85f94-948f-4718-8c56-2b8560960652	linux		
db873b4c-e766-431d-adad-b095988641cb	bc754abc-53be-4b71-9911-6bd2a26079c2	root	admin@yourcorp.com	dfe7a60ef268d2a15ba2e2197f3973d8:39f6eb462e9e12922b7f5d7981852311:Rgym/K1GVLiav+in		d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 11:52:01.738+00	2026-06-14 06:49:55.566+00	2026-06-14 06:22:56.711071+00	2026-06-14 06:49:55.566+00	f	\N	\N	\N	linux		
\.


--
-- Data for Name: servers; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.servers (id, name, hostname, ssh_port, environment, tags, host_key_fingerprint, host_key_verified, host_key_last_seen, management_key_id, management_linux_user, is_active, last_connected_at, added_by, created_at, updated_at, os_type, host_type, host_type_detail) FROM stdin;
f1965315-4ef5-4ebc-9645-624dc7e716d1	ubuntu-test	ubuntu-test	22	development	{}	0000000b7373682d6564323535313900000020d463c5aa4897778544b5eddbe37831bd2549d0426d50c2133b7d850ff35379f0	t	2026-06-13 13:25:51.115+00	\N	root	f	2026-06-13 13:25:51.115+00	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 13:25:40.040874+00	2026-06-13 13:45:56.838+00	linux	\N	\N
1ad10b0f-9b8d-416d-8c4c-e7c939ed3a92	ubuntu-test	ubuntu-test	22	production	{}	\N	f	\N	9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	root	f	\N	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 13:03:44.9191+00	2026-06-14 00:39:10.6+00	linux	\N	\N
ea0bdf3b-ea62-49fe-983a-fa6440a43ae9	debian-test	debian-test	22	development	{}	0000000b7373682d6564323535313900000020b35a54444e8ee5e68abe722f4651e35bcf0f4822cb06976d07602b08b73c91f4	t	2026-06-14 13:34:11.433+00	51404778-6336-42e7-a74c-89fef1b50af0	root	t	2026-06-14 12:49:25.378+00	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 08:03:38.804367+00	2026-06-14 13:34:11.433+00	linux	docker	\N
bc754abc-53be-4b71-9911-6bd2a26079c2	ubuntu-test	ubuntu-test	22	development	{}	0000000b7373682d6564323535313900000020d463c5aa4897778544b5eddbe37831bd2549d0426d50c2133b7d850ff35379f0	t	2026-06-14 13:34:09.644+00	9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	root	t	2026-06-14 12:48:48.131+00	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 13:46:16.408414+00	2026-06-14 13:41:52.441+00	linux	docker	\N
\.


--
-- Data for Name: session_recordings; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.session_recordings (id, user_id, server_id, linux_user, started_at, ended_at, duration_s, cast_file_path, cast_size_bytes, created_at) FROM stdin;
\.


--
-- Data for Name: settings; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.settings (key, value, updated_at) FROM stdin;
password_policy	{"min_length": 8, "max_age_days": 0, "require_numbers": false, "require_special": false, "require_lowercase": false, "require_uppercase": false, "max_login_attempts": 5, "lockout_duration_minutes": 30}	2026-06-14 06:05:22.830307+00
telegram_bot_name	"SSH Manager Bot"	2026-06-14 07:35:35.061803+00
telegram_enabled	false	2026-06-14 07:45:09.124+00
telegram_bot_token	"Van$1234"	2026-06-14 07:45:09.124+00
telegram_allowed_chats	[123456789]	2026-06-14 07:45:09.128+00
telegram_totp_secret	"JBTGYQK6HZLT4TKNEU2FGKCTMVNVG5JP"	2026-06-14 07:45:09.131+00
alert_webhook_url	""	2026-06-14 09:37:55.817232+00
alert_webhook_enabled	false	2026-06-14 09:37:55.817232+00
alert_email_enabled	false	2026-06-14 09:37:55.817232+00
alert_smtp_host	""	2026-06-14 09:37:55.817232+00
alert_smtp_port	587	2026-06-14 09:37:55.817232+00
alert_smtp_secure	false	2026-06-14 09:37:55.817232+00
alert_smtp_user	""	2026-06-14 09:37:55.817232+00
alert_smtp_pass	""	2026-06-14 09:37:55.817232+00
alert_smtp_from	""	2026-06-14 09:37:55.817232+00
alert_email_recipients	[]	2026-06-14 09:37:55.817232+00
alert_telegram_enabled	false	2026-06-14 09:37:55.817232+00
alert_telegram_chat_id	0	2026-06-14 09:37:55.817232+00
alert_events	{"new_login": false, "key_revoked": true, "key_expiring": true, "login_failed": true, "security_high": true, "rotation_failed": true, "rotation_success": false, "user_deactivated": false, "security_critical": true, "server_unreachable": true}	2026-06-14 09:37:55.843+00
\.


--
-- Data for Name: ssh_keys; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.ssh_keys (id, name, description, key_type, public_key, private_key_enc, fingerprint, rotation_policy, last_rotated_at, next_rotation_at, is_active, created_by, created_at, updated_at, archived_at, archive_reason, archived_by, purge_after, successor_key_id, predecessor_key_id) FROM stdin;
ea701fb1-1901-4291-96f7-172d15ddf878	pvd.priv	\N	rsa4096	ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCf+X8PWUecX3yyyFZvp+qn8hHIufs7EFEAnloKxcA072YaYJe4FA5jqd4KFpmJaw2mXYj7MzjSWsQNgNMJR7/cKn9EzIi1sMgejUqKOJwx0ogfkfnps4F2Tq8fkcPtVTEl1ZZybc9D2TYsw468/DwvcUTB/sb9TAG4fRrv572vUcJ5N4DV8vWDGVqCazPVueumWLBdFVUNnJQW4Eeq9Mc2ZuCYEsNETVS7Liwc69tGsHqXYg0yzbRbmj9cVxMELirxDnez+rYnhuC2IxtQuujPQEcXf7pWTcZC81Dnx8b0A9rXb1ey8SQqLNnDFN8zPBy/uMql0WIL4jgtRA5teoz1 (unnamed)	4b444fe6622fda886cf4d232eba83993:0975831976a5cba875fc19b3313c532e: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	SHA256:Fg5GuhLUhzKjoq8LsWqT+SuKF8iJ/DohjvWIEyOH78w	manual	\N	\N	t	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 00:13:33.150055+00	2026-06-14 00:13:33.150055+00	\N	\N	\N	\N	\N	\N
9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	pvd-key-01		ed25519	ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILTEaVCq5n42/v/Lh5+UcMVsmR3uFl0MkxjA3alslqFU (unnamed)	72c08f1c4b32fde05c5ac137c7a7b4b1:b7fc30f04b96ea685f9af6dc0a74e008:jJk/WfXXMcpV8S2aONc9ERCCyUHcPrxJ4f7er7L0vJ/hmeYVWTQdOB8kzv9G00RWQHXevCnVsGcHeg8PO4SKebUNb8y7ESxVBmcCnB7PeIGlxhLhwuFc9FEP5caas0xy46HfJi1Q4tLWNI3BTgp5G1utoaOiV7Sfaj46mN3Ab38XKeNXZqYMp5nTpnmqrRjSXbRkVNPJy8sUAv0IgaDdmSnKu12w3WZgwuPSNgP8Js64uFaK6iwKvoVW1/g2XxcHHlxJWCwROw1Ag1J+1kmLFqoCXgHy1BDwvwVi879nnPTDH7G8NEDNkypmKD2YIGjBgfwtKwcE4mWyNNUaf47rWB+60wxJmH4RMct04b9yLaNDGwWkiRQwrvNCb6dQ8y0kp6e7H9DTZCzHwOiUFLsKufRKwcnAmfVq7ZEO2m1cuOjtnmFdk4JHE+fCJ7wipLKM2PhWdUoTOhvfZHzHxxem6vCEnXLEq/dJs3t8oqOpo1HmM9X6I6PACBjY3+bnxuwBVTOLRdeYenxJCmNxGtEw	SHA256:bSIK5GVUb0ZkkqGh/En6HAlC+V5heOEKC7xzk2j/d0E	90d	2026-06-14 00:39:10.585+00	2026-09-12 00:39:10.585+00	t	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 00:39:10.586107+00	2026-06-14 00:39:10.586107+00	\N	\N	\N	\N	\N	96390f78-fea5-494e-af26-06fe6e91d406
96390f78-fea5-494e-af26-06fe6e91d406	pvd-key-01		ed25519	ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP5WdLZJ27RdN5CM3QMnuCgw7PcrP8py5hgH9Vakmnfx (unnamed)	d4dfe77bb1ccbb68fdda9b27cb22d9be:fc31ade8d2874ff60f1e44da5410808c:zk4h54UNDbujzyIt2Mc70uGXsSMP1I7jg4uqUzlAtziqxqieHszpZPBmA8QfOCiYISpjOPOvkgNg7JC0+CLQGj3JvYcG6TpxyvRgTMPHYI/ysw8GpffunlgLelEN/Kt0caSmdSMkuHnEWv75i1pDcIVXl7E5APCb/Mt1LJA0i+Av4gV6jI8mUDngRYf7uatXdccVlO/AhTqLMS1tzdOSgGdQimQHQEuxKX4TNVJXaMxO0EwbjDYvjG7z+oSHUdCMvEUGceE22XlIJkAFQLCAVzCd1xkK7rvEhqHZfs5L61ni1OHtSoliF6Ci8H1keP/W9rbJg50/g1Spj3VnrgWhX/hRyklSXRuSrcrLEDQw2FDh9Bnc0yFHJ9KUvsEhNB5Pva1MzJ1gfO634ZfX0+4OzLlmoVjuhLMmbvWmpiexIAVtolTTQMLHBOFux4Jsdvqj0eMBeqIx5Saur7T5NDHu3NkyS5xntBSof7IqleE5FSpb1LeGOWWnwceh6go7k5Xo/khxmBzSLybKa30e+Pab	SHA256:7aiAtNe70Fj1rqjPwuqj/fTSjNcLTdjd1jBa0hKtdvY	90d	\N	2026-09-11 12:52:49.95+00	f	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 12:52:49.977557+00	2026-06-14 00:39:10.59+00	2026-06-14 00:39:10.59+00	rotated	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-07-14 00:39:10.59+00	9f237fc9-ed0b-4e2a-b7fe-78c65309b9a2	\N
67c5570f-d26b-4bdf-b073-99dd2c059b8b	mgmt-ubuntu-test	Auto-generated management key for ubuntu-test	ed25519	ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOyOPnDEtjLI3xVvp+qvohwPEvnAcBPZAHcbKVqyiNJV (unnamed)	c52bb2022f8fc422dccd1d9032add67d:13ed0155515adae306daa3d7d2dfbc37:W7RuZEhq1aiSLs8fT2ddjKlEyr1HbBGOl1+Vya9ZmE8Gv70rmK6NCXg4Qnm3exhTbPwYTMW8DmaZwlWz3vYwHoyCatCw3pJVvA5lB1lUGfyT6/9QNeyW4DQlwHRDoN5JEj0H+h8Adnd5KxjhgmBuRI8k1JSNMBA=	SHA256:PAwh3QZPLWBmylHdDdVTm4xy3FsyFgnzJQV9mteHV2M	30d	2026-06-13 14:38:17.229+00	2026-07-13 14:38:17.23+00	t	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 13:46:29.354927+00	2026-06-13 14:38:17.23+00	\N	\N	\N	\N	\N	\N
24bfeefb-7ca9-4600-a611-45566500e2f4	Vandet-key	admin	rsa4096	ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC6nGmMG5PzeoQkbhGfJ+roYmrl9xwRj5NIxUECZbZQGlMw2VFp38vwTnlixvH1759AGL9zSlfIfCAfALMIFUyzkQawQ2JHbf7/upxg4rxT60imPWFkfRpdKKomvDce1oSsSpekh7/hq98XDMUguitykL2onG/0dkls41/C0kfgKtqk0cpTfhimsPqpglCZLbSfO7wlMeixZkdDS9BxxuZvtifU7DzOpSbFtSLA6ekO9s3dA2SC671xlp6bDQ5/cLRZzSABWBX/o2lCqBipbu7eSvLrTnoflFhqQSXfVKeR6nuL8Bxfx/lez4S5xVVrW3LaOi3KAM/Uv0D4CbEIA5fNHwJnU9yHUTKV+7d7nVXSAf+EYTCwsJgGm1OQJZGAlXCE4K3fJrscaOgvzsAEuybZiqIigF7uKwgiEoty9e3byytamhfgLfCUqqY4wMGnv7d3Ab1ltCDxuji9uDfE3dyfvT3w8yzDAVpRPpr1WPgN9/xdDJv4uVaPG9qziaSCE6KE0BSZzSbCVkis6L1XqLDUH1XWjAeMNIW1FrCWnxHs/4uKnm3GbefZdM90UV4kf28yTpUSEIhbVFNDqzT742AoIyyq43DwsY63tVJ5glFOGiFpqJQ+RZ+uSCE7S+C1DOqGgnuaf6rcl7x8w9Uc8TZgFTIus88LA3FPDGnJ0SPJAQ== (unnamed)	9252ddc37b1f276b4d320394a393040a:b4c9d95f25a2856dfd44a48264de93d9:rIzcQ92Td363OAyTMu3RLvFH/b43555cZ1uT+s93lnKxaEgyWJYuHbE1KTidz8ASsVSuuTOQyBeXKCU2BrW+2TDEpYGSe8p9Z7qLXs2dFoP/ioJWwfkAcl0dXHIY2dHV6kUs37VRSedwkSBhUL2b0O4eXk4Iw+2BAgdJ3uD/BmGXpy8xvtSqB8JOBD8YobFmaQTexkiu21/d6TDQWGTDxIL4LqNIecOpJfH1TKK6Nux+mRAjAV9ibYpj3x+QuMHHUv4Wj7ZSUeoknQSy5egAd/MaZNYjAKrDCji9zMORtUgGMQ/p/e5o4g+/SM0b5nv8utLXc5lJeVnGX83bMVXzlCe8G+b3xTdTlBZVeKT7UGcvMOSLl6KiaAYnmGJBSb8hHx7PcHyPh+ynF58rV0WOHhMH0GHo8XV5oV0d6kuAWrRTezfLzkOS3j2G0rOMygT2Pd8Wf6wUGWne/2/9RRq8ofuWlCW1eT52Nz/6pDT97ikSpTfhcztG5Lpt2WgjLwRMXE75xntThncGyJ+/ze+4f8UicrsOgDOz2NuAE1jHrMyecr5MOORK6+hTH32HlNB3vAjigdgSa1EXl7BdrZFaOU6vfTcRGB1dme9Klr6YyL6QiPraMyb3L54J4vcILg9JPVA0+PfL4JT3C6KsImXuFAmD9In6UcyeB5S34pAN4Ithrm8A45dyb0TOKEwQgIUqJ4s2fpN7y8AtV1cusCWlefuUsMimJLq6jTids/0ZQlW2TOD099ojRHvmiBkuNQpxLsVlry/n4alEaS0HOKPiguDxofyZOauAlEccu1zgcQm9To/CAXM9SxFykR7uCuM4Ff7lurYWm+RoOwsrjhy2ZtKgUsUWSKgUAwkaCeG/muXlLsZ2fjf/RfFbm97q0KN3q9x0QdUF3T/y/Ee5LP5JR6FJE4AfqTRchzXIxMv6+jF8zL3kwvAR4LysLPdj/uy9+73rxxCd1GPmd10/H1DdazlfK1gFKO+hWPigQoY/4nqy67ZXlwULiii1whdJccNo2G3mzBHgdKabcAjbqqTU4xWwITOokZ5UPiV6MhnrvIHOj7UrCrUEVWXV1kbtHEkiJMsx89De3ZqT7vPG04q/uDBR+zFBJEKAWn18LhapeHwZA+E0HzQV0oxi1uqzWt/R8BBT0dOcL2/erUKyVp6fWHokvHZDMjCAZQcIH7y4JOmu2TkvjWLdpgWSZpE15nCHBLjaLT9dWuNtlGKktPX6dY+LQ+TBEPuFSwDVa7YDvm0w4blF/ls/4zqiqj9rJ0Ltbk5EWylA82TQGjWdNv4RZ1Y1CA6rEukU1K4EpcfB6L76iZY7uy+96V8eSPEaxQXhJRTklmLtH5Xu1NDGZiTjh+AWoXrDrxpGzoqFW3/7Ymp7HlmAQAVqtX8AcHV9ayPP+v8ynngV5/r8QFScKOjaD8LNUdtUwetIwpsA+ACq59i84z/O/buFGJv9xlYibLzUzNIvfkg1SSfvh8hsvbqh/bRBeowEL/W6eUSHZZWB2Ld9kh1XfjXDZ7MiSi9eW+wEBhvWDypzF2igaHk/FlXIJhKIi3qoJcEg9xQgnUi5xy8SmqyPVuZ1Ohy4fxdvtsx3aacWtdvmpMhw4m3toKwwEeNEjTuVaq2PWvGQknKjzYrCQ0qshtt0VBBak52HRHCaQ5nrO1kF5+XH2ewBBrQLDaOxYj+wu6SyOYBPvFrD+pM3OJWyGhrj1PmITcF91VK+kVXOMLROATBU3qxg5ZRss9XyBbs+L1G/h2Tcltm7NdCFDU47FoycJRxVCN0JWYoXp39s7iluvhHey+ecgmBBEqDam5a1Tu3Cl8k2yPNz9tAD4HXB7IxYQk02SR4ItMgRDZPcAcAG8BKsjwKh/4nUyPJOquzAoOzjjmi8QM81w15lSZrBCcUvRKRwzKBi5GH7Is+WuxAk0xVBN4DYfeiseIEVbdxB+quPCv20WYBNmS2pqr3SCVks00QMWKKgVGTkcTwWcNWWdp0Z8MmIU45tvkkCYlGOaQi8zEQMjuZ/MqqTjejfkykfe86wPMxSVHj0mXJKWxTGNcuPRmZTWrGQ7wPeS9ABJ7zG45PuezrQLCCaD8Lti17APU313Nmd1New4xreMGLpv7KLq52um91iCbV5N9WdGH9m11vZteSZCUAk3ZeMeIqSOlKQHiut5leUK9xJb7u5ABG78qnexLyDqPISMuyg35QSgOL9son27rXsquHMzuLIT6yxPrCd9i7ozQDqcyp37JUnJpfx/LiduTH571fbs41PrbOE4AVjr6Tg5jDSOCeIfgEfRkYDHVz8Dr8ffBbXkdkLjh1E2+TP8V0N2NXdwPdjHnACSXoemZn3pVND2uGkjJGeKOA/hUGRW/RrgKYiSkwLXXaydPOTWOLHZh+/SSN1tz7WB1si3TQiuuYudZLS15CfgKLHBoDJvk8M60n2DSA2EdfqtOXQJKK0il/3a4L6CNS0lEWgSJDzFgRZIEpyoC668hdYd9dvGwoaB0Bm2JXW5rIspITOrNU5EuEVXdWXldMKTYzOsQSlxQCki/EoVsHyqJIJnqGbMAsGasgugOvV9Ben7rHPt4aioUe1Fa4MKIKjkg5xa8m3om3cwdlPpKP48eiXQWWo2kgQACv2tlMjXB73w7y0hs+wnSxRx6NkXDD6P17bFGdop5C88HftdMQMr3N21dD9GhtSP19hLq2OnHuuvhLZzKc/Qnt5NKKh5FTBFDVAvU1ZQcXqAVHfUuy8VewRQ8GRzQerIudBKLi8pfQgELi0tD1gKAazql5fBhyBYNrHb3YhpZ4vURRr6AyfPhPiueZHjl/2oKjMrPgxEoWOqN/mJNIVXvXOxd70jfc6Hz2foH9DuR+xo9SOooRdklxxo69lo3nD+qEd2Bjleevc8F4nYlP/YFExo3djn7w+V1g9c41EFfaswtfgb84Jf6xuw4h1W3JjCwZnkR40wopGHbAkmt203iJILdwGVTh2jVeDwizoNj93I3w/qqjoHueCEkkOK8fY9KHvmycX0xfxSpyxFBBe/+AgUbTQaGKyi5z1RBo/7JPeNJ/ckEp+RzD0MvDX0xhUCK4CI4jsKMw+IXsQqGK+GeYVNqzz3oD4bldrlyv8aTzAPtZi8Oi11uU2TvsCg/T1h2KPkCne3MbgutIgaMSz+omeLbCDMnzSKA45zAnUoha6ZcuaUBX/9Ct9agr2qlGC9BUDNcIBVd5E5lUmr5mjzJQT3wy9Qh8dOw6FGrpWhbPAH3nxUyLvvNcV16ct15RwUBfyg258vH5FlkVGSIKpxDUJq42CYlrnW93rOoYc0rqlE0vVxkx4vsUColHMCMt6/Pr4WG+EaYiNZks6YqhyFrh9iPJ7bm4HW8jN727Uc/Hmc1iZI7T/Sf4DuY6m/joQ0/loBAEa0JIiob8GXwiM3bJIsYLR0J8v5siWEjBVGavuZ1Reu0qjJiWbQu41a6LgmAA9Eon9Oo/m6VeJTRg6XvaDxV0Ha2efhCfyOgc0LHyTa3Sec/i1ztcjhXS5Am7c0H7MANRjZvPg+rWjl+KIu3XvTizj1M7aeCCXiMK/wt2aAld89ba/ZBdX1FRD4pXGUeERt4yfQEUGqkG9lHFyCjAJmrgBhFIl64gW9nvi1jLbOeNoNE1mbkZpuWrwizjMT2Ez+dd6LbjjbYbcFMGDCFOcZtq4dNogrEERUPm4EiF3rMzMFtdEc85/C3aRqTeUAN070UW2+agRiGe85+/UQ7stA68yK45PrdkZKig70SwLmJXcfD3mwmsPXs28re6nf7uPUJZJ+gQlXAHpb5AggcWBzkgg/py8uD88VY5WjWmEOlxv/xVeEmvHRFXN0DV4xOxCVYVUrEVWM+FSb49oFoXYXJmuNDkBof1FioYhz2giT1Eg1ZIz5gMIl5c9rY+7xd9xfeRXp8ImtR+lC2rX59MxYbmD42AGoT8+TkWK0OBFFsKbRzTPmFjMrB9Bxg18j9T+t3Lwg1qq+XqRxkQhOicC1E+PA2FJTtjiSPMqCdWWjewOGt922NX7MJ/Ngeb9gKM/LDpLIwdhnUzIa09Jl/77Ba/6romFg9siARG8Gd0/VZ4+JMou1mBRb+Cmth2ylNFcCj7cUNqoojevgLgRlXJB0UmbO0UniheJxM5NKybLxpP2pIoDJrLfTWpz9dpB/1BPg+asTG3t0CGtExCGp10bomqH0x8l+AD23mn2mmwrEddgeUPpd4tbkMEUMRttQxm+lfAYhC4BQoCrP+1kHhouUX6Qb6V/upDHBMteDAqzDLzAMA3qSSlfMeOLku6pNBnUxdLSK/cRnkC+Rkx4V5t8TnJnuNv7AxpUok5e9HWgWil6JXEkKkXongm+P7P6BC4IDlfgHblToKgy75ycHm+k0uD6gUhrSC5ECfU3h4UGnRqfTYjBMyUeW8XTG8318UrnbnLZhWTd1dxMvRg0AITmJc6rpvfCYOGuH7HmvQboJNiDVilIfw0Jn0KzrHIztDeIbBnW	SHA256:LpDfC/fVClGqxvRIAbrzd4HprlMwUJKguMmPMdy168M	manual	2026-06-14 00:39:55.091+00	\N	t	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 00:39:55.092545+00	2026-06-14 00:39:55.092545+00	\N	\N	\N	\N	\N	2c0598f9-189c-48e8-8fd0-3f97ff5ce3b4
2c0598f9-189c-48e8-8fd0-3f97ff5ce3b4	Vandet-key	admin	rsa4096	ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCvFRQ8eI5u4Sdt6+4HiAcJuBHpfDBF9dQRHAtGwDfx0L2AskoVxkjUAY5Xc332ITOkbx1mlzwWQPe9McXty1NtiK58ihMYmKKvW0m1fKyAqn2uL6jEC7wBnt7PJk0/QwlGzpKUvkBhw1JIr2PnOgzesUrGC8InmBNINMKMX6SyvHXMT4QB1vOxAk4FpaPj2GXWTb6l18CXaqXNA60lUY9dOwZnwdDfjzYK5lTgdyPnHqb3v6HGxN4BxPARLMNLoC2rRBsXRQMMTHLFpLhmCVfBuSS3na55lwTGLTjrMafYoJMGlPKKF6yrJE/KAFnYNAZ/4Iw7ZtEwYfPfFy8PIe43otxjW2snNk3SEHcxOTb0jDpctpLbocQ+PgY3jt30Wr4hbTbHa4y4Ded8QjaDM/1sU6/hY3rx6VBt3Vqz+YCSFos6LOI3ZEoJIF0quXbLqgq7cuX98uX7DwYXDfnsZQ91Ke2yE8NjtVFeKQRyg9zB7RG20x6moxSnGxepfsebgILA82qzkye4MoOxA2LBmVwvwt/Y4eJzEFHD/bCC1mipM26graE0GtInbYLXGGRb1rt9icQio2IlYGHSh9iBcUrD2IoDAun9mDfZNYfYpYhm81Dhv3PetCBxteacYKvBziiYEwYWUIkHaZ/Sv2Xgw9oSLU8ZEeXUpY3xmIcGPXD6Pw== (unnamed)	f0a006e6c394339fb8dd0d6f82da7149:ef897b444b3123272c44d414164c5829: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	SHA256:gDrKERdau7/VHcpujK5dk+5KWTv55kGGVVUGreHujyk	manual	\N	\N	f	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-13 14:25:18.363956+00	2026-06-14 00:39:55.1+00	2026-06-14 00:39:55.1+00	rotated	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-07-14 00:39:55.1+00	24bfeefb-7ca9-4600-a611-45566500e2f4	\N
51404778-6336-42e7-a74c-89fef1b50af0	mgmt-debian-test	Auto-generated management key for debian-test	ed25519	ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO25R00QDFjsTf2tn8ZVj5A6q70KasLqszL4vduj/Fkt (unnamed)	2777e8c7a051d00d77e0a6c42282090d:5197fb2453567b699b3b70785461e246:CSFjDxksCb+JNmNLFC/lsXg2BV4KVTMi1fhG7oQ+iHxJ1aoF6dlrWe8+ZsxySjG7igiXtR9+uaRz+HzFX+mRVSr08I6ZC/0h/9YGDeQtvBtqusp9ZETIoUziLouYiHJMBlYPiExn45CGGLH+b0VrLkxwpdfmxEtZiSME0yCnq/TU//ZR5Ia59fb1Pe3UK4yZkJFLgkTSGQuCd0+rFCGcTBKjrZFbk870WyZWZZzg3SlxWsfvtqF3ot6VkFUMG40hwjrs8bcnyu5tXYApHHnfBMZRQlDNcQBldi6lW00pBS7UrOnL1sOGU8fhQaXp2TRzHZB7H0kJSdsbq+sSG0g3m3668v9lwNonidrn/cqZIcqlj+6s/JUmb8mJ6JfxjwCGFKnBD5zyhfGt8HmLNO8ZAoUf/arB3xR3z8RyDvixEQBT1BG8FoUYynvxkThBru5OWt4I2e1Sq6t9FRlIa8HoZH0n4MMmKcH5Z+blnTQe4GSm0FguWYM6e44Jxic5v+eKfJGbGslJohi0pdKqsQgF	SHA256:+nKxS6QsRkoPX1PJnLYzVbEQXg4XIfZYqz0bcp6Rw9k	manual	\N	\N	t	d2921614-c65d-4759-9cdf-f38ef3bff16c	2026-06-14 08:06:59.390072+00	2026-06-14 08:06:59.390072+00	\N	\N	\N	\N	\N	\N
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: sshmanager
--

COPY public.users (id, email, display_name, provider, provider_id, provider_groups, role, mfa_secret, mfa_enabled, mfa_backup_codes, is_active, last_login_at, created_at, updated_at, password_hash, failed_login_attempts, locked_until, password_changed_at) FROM stdin;
d2921614-c65d-4759-9cdf-f38ef3bff16c	admin@yourcorp.com	Admin	local	bootstrap:admin@yourcorp.com	[]	admin	\N	f	[]	t	2026-06-14 13:49:23.436+00	2026-06-13 12:15:21.874752+00	2026-06-14 13:49:23.436+00	$2a$12$dU5TBpF.yM8MfduRzE9f..uMh97X1HJuv4oPLR8Tj8.AxuJ1qVRaW	0	\N	\N
\.


--
-- Name: audit_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: sshmanager
--

SELECT pg_catalog.setval('public.audit_logs_id_seq', 188, true);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: key_assignments key_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.key_assignments
    ADD CONSTRAINT key_assignments_pkey PRIMARY KEY (id);


--
-- Name: key_assignments key_assignments_unique; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.key_assignments
    ADD CONSTRAINT key_assignments_unique UNIQUE (user_id, key_id, server_id, linux_user);


--
-- Name: kysely_migration_lock kysely_migration_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.kysely_migration_lock
    ADD CONSTRAINT kysely_migration_lock_pkey PRIMARY KEY (id);


--
-- Name: kysely_migration kysely_migration_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.kysely_migration
    ADD CONSTRAINT kysely_migration_pkey PRIMARY KEY (name);


--
-- Name: rotation_jobs rotation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.rotation_jobs
    ADD CONSTRAINT rotation_jobs_pkey PRIMARY KEY (id);


--
-- Name: security_scans security_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.security_scans
    ADD CONSTRAINT security_scans_pkey PRIMARY KEY (id);


--
-- Name: server_credentials server_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.server_credentials
    ADD CONSTRAINT server_credentials_pkey PRIMARY KEY (id);


--
-- Name: servers servers_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);


--
-- Name: session_recordings session_recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.session_recordings
    ADD CONSTRAINT session_recordings_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: ssh_keys ssh_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.ssh_keys
    ADD CONSTRAINT ssh_keys_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_provider_provider_id_unique; Type: CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_provider_provider_id_unique UNIQUE (provider, provider_id);


--
-- Name: idx_audit_logs_created; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_audit_logs_created ON public.audit_logs USING btree (created_at);


--
-- Name: idx_audit_logs_server; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_audit_logs_server ON public.audit_logs USING btree (server_id);


--
-- Name: idx_audit_logs_user; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_audit_logs_user ON public.audit_logs USING btree (user_id);


--
-- Name: idx_key_assignments_key; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_key_assignments_key ON public.key_assignments USING btree (key_id);


--
-- Name: idx_key_assignments_server; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_key_assignments_server ON public.key_assignments USING btree (server_id);


--
-- Name: idx_key_assignments_user; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_key_assignments_user ON public.key_assignments USING btree (user_id);


--
-- Name: idx_servers_env; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_servers_env ON public.servers USING btree (environment);


--
-- Name: idx_ssh_keys_purge; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_ssh_keys_purge ON public.ssh_keys USING btree (purge_after) WHERE ((purge_after IS NOT NULL) AND (is_active = false));


--
-- Name: idx_ssh_keys_rotation; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX idx_ssh_keys_rotation ON public.ssh_keys USING btree (next_rotation_at) WHERE (is_active = true);


--
-- Name: server_credentials_server_id_idx; Type: INDEX; Schema: public; Owner: sshmanager
--

CREATE INDEX server_credentials_server_id_idx ON public.server_credentials USING btree (server_id);


--
-- Name: audit_logs audit_logs_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id);


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: key_assignments key_assignments_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.key_assignments
    ADD CONSTRAINT key_assignments_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: key_assignments key_assignments_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.key_assignments
    ADD CONSTRAINT key_assignments_key_id_fkey FOREIGN KEY (key_id) REFERENCES public.ssh_keys(id) ON DELETE CASCADE;


--
-- Name: key_assignments key_assignments_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.key_assignments
    ADD CONSTRAINT key_assignments_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: key_assignments key_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.key_assignments
    ADD CONSTRAINT key_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: rotation_jobs rotation_jobs_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.rotation_jobs
    ADD CONSTRAINT rotation_jobs_key_id_fkey FOREIGN KEY (key_id) REFERENCES public.ssh_keys(id);


--
-- Name: rotation_jobs rotation_jobs_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.rotation_jobs
    ADD CONSTRAINT rotation_jobs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id);


--
-- Name: security_scans security_scans_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.security_scans
    ADD CONSTRAINT security_scans_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id);


--
-- Name: server_credentials server_credentials_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.server_credentials
    ADD CONSTRAINT server_credentials_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: server_credentials server_credentials_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.server_credentials
    ADD CONSTRAINT server_credentials_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: servers servers_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id);


--
-- Name: servers servers_management_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_management_key_id_fkey FOREIGN KEY (management_key_id) REFERENCES public.ssh_keys(id);


--
-- Name: session_recordings session_recordings_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.session_recordings
    ADD CONSTRAINT session_recordings_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id);


--
-- Name: session_recordings session_recordings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.session_recordings
    ADD CONSTRAINT session_recordings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: ssh_keys ssh_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: sshmanager
--

ALTER TABLE ONLY public.ssh_keys
    ADD CONSTRAINT ssh_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict ZOrwKaSt7B4D5sWOdRyhCQBqIlVXQhyeFDg6Lx4xBXShFkw4DdOhHV3LwlhfDdF


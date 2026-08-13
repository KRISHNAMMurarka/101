use std::{
    collections::HashMap,
    net::IpAddr,
    path::{Component, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, Response, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use subtle::ConstantTimeEq;
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

use crate::storage::{list_game_packages_at, AppPaths};

pub const PROTOCOL_VERSION: u8 = 2;
const DEFAULT_TTL_MS: u64 = 4 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingTicket {
    pub version: u8,
    pub session_id: String,
    pub endpoint: String,
    pub join_token: String,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
    pub transport: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSession {
    pub ticket: PairingTicket,
    pub host_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingDevice {
    device_id: String,
    label: String,
    capabilities: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerLease {
    peer_id: String,
    peer_token: String,
    generation: u64,
    expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPeerSignal {
    peer_id: String,
    device_id: String,
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
    last_seen_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerOfferSignal {
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    offer: Option<String>,
    expires_at: u64,
}

#[derive(Debug, Clone)]
struct Peer {
    peer_id: String,
    peer_token: String,
    device: PairingDevice,
    generation: u64,
    offer: Option<String>,
    answer: Option<String>,
    last_seen_at: u64,
}

#[derive(Debug, Clone)]
struct Session {
    ticket: PairingTicket,
    host_token: String,
    peers: HashMap<String, Peer>,
}

#[derive(Debug, Default)]
pub struct SignalingBroker {
    sessions: HashMap<String, Session>,
}

impl SignalingBroker {
    pub fn counts(&mut self) -> (usize, usize) {
        self.expire();
        (
            self.sessions.len(),
            self.sessions
                .values()
                .map(|session| session.peers.len())
                .sum(),
        )
    }

    fn create_session(
        &mut self,
        request: CreateSessionRequest,
        default_endpoint: &str,
    ) -> ApiResult<CreatedSession> {
        validate_session_id(&request.session_id)?;
        self.expire();
        if let Some(existing) = self.sessions.get(&request.session_id) {
            return Ok(CreatedSession {
                ticket: existing.ticket.clone(),
                host_token: existing.host_token.clone(),
            });
        }
        let endpoint = request
            .endpoint
            .unwrap_or_else(|| default_endpoint.to_owned());
        validate_http_url(&endpoint)?;
        let now = now_ms();
        let ttl = request
            .ttl_ms
            .unwrap_or(DEFAULT_TTL_MS)
            .clamp(60_000, 24 * 60 * 60 * 1_000);
        let ticket = PairingTicket {
            version: PROTOCOL_VERSION,
            session_id: request.session_id.clone(),
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            join_token: secure_token(),
            expires_at: now.saturating_add(ttl),
            host_name: clean_optional_text(request.host_name, 128)?,
            transport: "webrtc".to_owned(),
        };
        let session = Session {
            ticket: ticket.clone(),
            host_token: secure_token(),
            peers: HashMap::new(),
        };
        let created = CreatedSession {
            ticket,
            host_token: session.host_token.clone(),
        };
        self.sessions.insert(request.session_id, session);
        Ok(created)
    }

    fn join(
        &mut self,
        session_id: &str,
        token: &str,
        device: PairingDevice,
    ) -> ApiResult<ControllerLease> {
        validate_device(&device)?;
        let session = self.live_session_mut(session_id)?;
        authorize(&session.ticket.join_token, token)?;
        let previous = session
            .peers
            .values()
            .find(|peer| peer.device.device_id == device.device_id)
            .cloned();
        if let Some(previous) = &previous {
            session.peers.remove(&previous.peer_id);
        }
        let peer = Peer {
            peer_id: format!("peer-{}", &secure_token()[..16]),
            peer_token: secure_token(),
            device,
            generation: previous.map_or(1, |value| value.generation.saturating_add(1)),
            offer: None,
            answer: None,
            last_seen_at: now_ms(),
        };
        let lease = lease(&peer, session.ticket.expires_at);
        session.peers.insert(peer.peer_id.clone(), peer);
        Ok(lease)
    }

    fn list_peers(&mut self, session_id: &str, token: &str) -> ApiResult<Vec<HostPeerSignal>> {
        let session = self.live_session_mut(session_id)?;
        authorize(&session.host_token, token)?;
        Ok(session
            .peers
            .values()
            .map(|peer| HostPeerSignal {
                peer_id: peer.peer_id.clone(),
                device_id: peer.device.device_id.clone(),
                generation: peer.generation,
                answer: peer.answer.clone(),
                last_seen_at: peer.last_seen_at,
            })
            .collect())
    }

    fn publish_offer(
        &mut self,
        session_id: &str,
        peer_id: &str,
        token: &str,
        signal: SignalBody,
        answer: bool,
    ) -> ApiResult<()> {
        validate_pairing_code(
            if answer { "answer" } else { "offer" },
            &signal.value(answer),
        )?;
        let session = self.live_session_mut(session_id)?;
        authorize(&session.host_token, token)?;
        let peer = session
            .peers
            .get_mut(peer_id)
            .ok_or_else(|| ApiError::not_found("Unknown signaling peer"))?;
        if peer.generation != signal.generation {
            return Err(ApiError::conflict("Stale signaling generation"));
        }
        peer.offer = signal.offer;
        peer.answer = None;
        peer.last_seen_at = now_ms();
        Ok(())
    }

    fn get_offer(
        &mut self,
        session_id: &str,
        peer_id: &str,
        token: &str,
    ) -> ApiResult<ControllerOfferSignal> {
        let session = self.live_session_mut(session_id)?;
        let expires_at = session.ticket.expires_at;
        let peer = session
            .peers
            .get_mut(peer_id)
            .ok_or_else(|| ApiError::not_found("Unknown signaling peer"))?;
        authorize(&peer.peer_token, token)?;
        peer.last_seen_at = now_ms();
        Ok(ControllerOfferSignal {
            generation: peer.generation,
            offer: peer.offer.clone(),
            expires_at,
        })
    }

    fn publish_answer(
        &mut self,
        session_id: &str,
        peer_id: &str,
        token: &str,
        signal: SignalBody,
    ) -> ApiResult<()> {
        let answer = signal.answer.clone().unwrap_or_default();
        validate_pairing_code("answer", &answer)?;
        let session = self.live_session_mut(session_id)?;
        let peer = session
            .peers
            .get_mut(peer_id)
            .ok_or_else(|| ApiError::not_found("Unknown signaling peer"))?;
        authorize(&peer.peer_token, token)?;
        if peer.generation != signal.generation || peer.offer.is_none() {
            return Err(ApiError::conflict("Stale signaling generation"));
        }
        peer.answer = Some(answer);
        peer.last_seen_at = now_ms();
        Ok(())
    }

    fn reconnect(
        &mut self,
        session_id: &str,
        peer_id: &str,
        token: &str,
        host: bool,
    ) -> ApiResult<ControllerLease> {
        let session = self.live_session_mut(session_id)?;
        if host {
            authorize(&session.host_token, token)?;
        }
        let expires_at = session.ticket.expires_at;
        let peer = session
            .peers
            .get_mut(peer_id)
            .ok_or_else(|| ApiError::not_found("Unknown signaling peer"))?;
        if !host {
            authorize(&peer.peer_token, token)?;
        }
        peer.generation = peer.generation.saturating_add(1);
        peer.offer = None;
        peer.answer = None;
        peer.last_seen_at = now_ms();
        Ok(lease(peer, expires_at))
    }

    fn live_session_mut(&mut self, session_id: &str) -> ApiResult<&mut Session> {
        let expired = self
            .sessions
            .get(session_id)
            .is_some_and(|session| session.ticket.expires_at <= now_ms());
        if expired {
            self.sessions.remove(session_id);
            return Err(ApiError::gone("Signaling session expired"));
        }
        self.sessions
            .get_mut(session_id)
            .ok_or_else(|| ApiError::not_found("Unknown signaling session"))
    }

    fn expire(&mut self) {
        let now = now_ms();
        self.sessions
            .retain(|_, session| session.ticket.expires_at > now);
    }
}

#[derive(Clone)]
pub struct HttpState {
    pub broker: Arc<Mutex<SignalingBroker>>,
    pub endpoint: String,
    pub addresses: Vec<String>,
    pub mdns: bool,
    pub paths: AppPaths,
}

pub fn router(state: HttpState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/sessions", post(create_session))
        .route("/v1/sessions/{session_id}/host/peers", get(host_peers))
        .route(
            "/v1/sessions/{session_id}/host/peers/{peer_id}/offer",
            put(host_offer),
        )
        .route(
            "/v1/sessions/{session_id}/host/peers/{peer_id}/reconnect",
            post(host_reconnect),
        )
        .route("/v1/sessions/{session_id}/peers", post(join))
        .route(
            "/v1/sessions/{session_id}/peers/{peer_id}/offer",
            get(controller_offer),
        )
        .route(
            "/v1/sessions/{session_id}/peers/{peer_id}/answer",
            put(controller_answer),
        )
        .route(
            "/v1/sessions/{session_id}/peers/{peer_id}/reconnect",
            post(controller_reconnect),
        )
        .route("/v1/games", get(games))
        .route("/games/{game_id}/{*asset}", get(game_asset))
        .layer(DefaultBodyLimit::max(500_000))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any),
        )
        .with_state(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    service: &'static str,
    version: u8,
    endpoint: String,
    addresses: Vec<String>,
    mdns: bool,
    session_count: usize,
    peer_count: usize,
}

async fn health(State(state): State<HttpState>) -> ApiResult<Json<Health>> {
    let (session_count, peer_count) = state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .counts();
    Ok(Json(Health {
        service: "101-hub",
        version: PROTOCOL_VERSION,
        endpoint: state.endpoint,
        addresses: state.addresses,
        mdns: state.mdns,
        session_count,
        peer_count,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    session_id: String,
    host_name: Option<String>,
    ttl_ms: Option<u64>,
    endpoint: Option<String>,
}

async fn create_session(
    State(state): State<HttpState>,
    Json(request): Json<CreateSessionRequest>,
) -> ApiResult<(StatusCode, Json<CreatedSession>)> {
    let created = state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .create_session(request, &state.endpoint)?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn join(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(device): Json<PairingDevice>,
) -> ApiResult<(StatusCode, Json<ControllerLease>)> {
    let lease = state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .join(&session_id, bearer(&headers)?, device)?;
    Ok((StatusCode::CREATED, Json(lease)))
}

async fn host_peers(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<HostPeerSignal>>> {
    let peers = state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .list_peers(&session_id, bearer(&headers)?)?;
    Ok(Json(peers))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignalBody {
    generation: u64,
    offer: Option<String>,
    answer: Option<String>,
}
impl SignalBody {
    fn value(&self, answer: bool) -> String {
        if answer {
            self.answer.clone()
        } else {
            self.offer.clone()
        }
        .unwrap_or_default()
    }
}

async fn host_offer(
    State(state): State<HttpState>,
    Path((session_id, peer_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(signal): Json<SignalBody>,
) -> ApiResult<StatusCode> {
    state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .publish_offer(&session_id, &peer_id, bearer(&headers)?, signal, false)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn controller_offer(
    State(state): State<HttpState>,
    Path((session_id, peer_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Json<ControllerOfferSignal>> {
    let signal = state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .get_offer(&session_id, &peer_id, bearer(&headers)?)?;
    Ok(Json(signal))
}

async fn controller_answer(
    State(state): State<HttpState>,
    Path((session_id, peer_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(signal): Json<SignalBody>,
) -> ApiResult<StatusCode> {
    state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .publish_answer(&session_id, &peer_id, bearer(&headers)?, signal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn host_reconnect(
    State(state): State<HttpState>,
    Path((session_id, peer_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .reconnect(&session_id, &peer_id, bearer(&headers)?, true)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn controller_reconnect(
    State(state): State<HttpState>,
    Path((session_id, peer_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Json<ControllerLease>> {
    let lease = state
        .broker
        .lock()
        .map_err(|_| ApiError::internal("Hub state lock failed"))?
        .reconnect(&session_id, &peer_id, bearer(&headers)?, false)?;
    Ok(Json(lease))
}

async fn games(
    State(state): State<HttpState>,
) -> ApiResult<Json<Vec<crate::storage::InstalledGame>>> {
    Ok(Json(list_game_packages_at(&state.paths)?))
}

async fn game_asset(
    State(state): State<HttpState>,
    Path((game_id, asset)): Path<(String, String)>,
) -> ApiResult<Response<Body>> {
    validate_identifier(&game_id, 64)?;
    let relative = PathBuf::from(asset);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ApiError::bad_request("Invalid game asset path"));
    }
    let root = state
        .paths
        .games
        .join(&game_id)
        .canonicalize()
        .map_err(|_| ApiError::not_found("Unknown game package"))?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| ApiError::not_found("Unknown game asset"))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(ApiError::not_found("Unknown game asset"));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::not_found("Unable to read game asset"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(ApiError::bad_request("Game asset is too large"));
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(&path)
                .first_or_octet_stream()
                .as_ref(),
        )
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(bytes))
        .map_err(|_| ApiError::internal("Unable to build response"))
}

fn validate_device(device: &PairingDevice) -> ApiResult<()> {
    validate_identifier(&device.device_id, 128)?;
    if device.label.trim().is_empty() || device.label.len() > 128 {
        return Err(ApiError::bad_request("Invalid pairing device label"));
    }
    if !device.capabilities.is_object() {
        return Err(ApiError::bad_request("Invalid device capabilities"));
    }
    Ok(())
}

fn validate_session_id(value: &str) -> ApiResult<()> {
    if value.len() < 4
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(ApiError::bad_request("Invalid session id"));
    }
    Ok(())
}

pub fn validate_identifier(value: &str, max: usize) -> ApiResult<()> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ApiError::bad_request("Invalid identifier"));
    }
    Ok(())
}

fn validate_http_url(value: &str) -> ApiResult<()> {
    let parsed =
        url::Url::parse(value).map_err(|_| ApiError::bad_request("Invalid HTTP endpoint"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ApiError::bad_request("Invalid HTTP endpoint"));
    }
    Ok(())
}

fn validate_pairing_code(kind: &str, value: &str) -> ApiResult<()> {
    if value.len() < 8 || value.len() > 400_000 || !value.starts_with("101") {
        return Err(ApiError::bad_request(format!("Invalid WebRTC {kind} code")));
    }
    Ok(())
}

fn clean_optional_text(value: Option<String>, max: usize) -> ApiResult<Option<String>> {
    value
        .map(|text| {
            let clean = text.trim().to_owned();
            if clean.is_empty() || clean.len() > max {
                Err(ApiError::bad_request("Invalid text value"))
            } else {
                Ok(clean)
            }
        })
        .transpose()
}

fn bearer(headers: &HeaderMap) -> ApiResult<&str> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("Pairing authorization failed"))?;
    value
        .strip_prefix("Bearer ")
        .filter(|token| token.len() <= 300)
        .ok_or_else(|| ApiError::unauthorized("Pairing authorization failed"))
}

fn authorize(expected: &str, received: &str) -> ApiResult<()> {
    if expected.as_bytes().ct_eq(received.as_bytes()).into() {
        Ok(())
    } else {
        Err(ApiError::unauthorized("Pairing authorization failed"))
    }
}

fn lease(peer: &Peer, expires_at: u64) -> ControllerLease {
    ControllerLease {
        peer_id: peer.peer_id.clone(),
        peer_token: peer.peer_token.clone(),
        generation: peer.generation,
        expires_at,
    }
}
fn secure_token() -> String {
    URL_SAFE_NO_PAD
        .encode(Uuid::new_v4().as_bytes())
        .chars()
        .chain(URL_SAFE_NO_PAD.encode(Uuid::new_v4().as_bytes()).chars())
        .collect()
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn ip_strings(addresses: &[IpAddr]) -> Vec<String> {
    addresses
        .iter()
        .filter(|address| !address.is_loopback())
        .map(ToString::to_string)
        .collect()
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }
    fn gone(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::GONE,
            message: message.into(),
        }
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> CreateSessionRequest {
        CreateSessionRequest {
            session_id: "TEST101".into(),
            host_name: Some("Test Hub".into()),
            ttl_ms: None,
            endpoint: None,
        }
    }

    #[test]
    fn broker_enforces_distinct_host_join_and_peer_authority() {
        let mut broker = SignalingBroker::default();
        let created = broker
            .create_session(request(), "http://127.0.0.1:10101")
            .unwrap();
        let device = PairingDevice {
            device_id: "phone-1".into(),
            label: "Phone".into(),
            capabilities: serde_json::json!({"touch": true}),
        };
        let lease = broker
            .join("TEST101", &created.ticket.join_token, device)
            .unwrap();
        assert!(broker
            .list_peers("TEST101", &created.ticket.join_token)
            .is_err());
        assert_eq!(
            broker
                .list_peers("TEST101", &created.host_token)
                .unwrap()
                .len(),
            1
        );
        broker
            .publish_offer(
                "TEST101",
                &lease.peer_id,
                &created.host_token,
                SignalBody {
                    generation: 1,
                    offer: Some("101-offer".into()),
                    answer: None,
                },
                false,
            )
            .unwrap();
        assert_eq!(
            broker
                .get_offer("TEST101", &lease.peer_id, &lease.peer_token)
                .unwrap()
                .offer
                .as_deref(),
            Some("101-offer")
        );
        broker
            .publish_answer(
                "TEST101",
                &lease.peer_id,
                &lease.peer_token,
                SignalBody {
                    generation: 1,
                    offer: None,
                    answer: Some("101-answer".into()),
                },
            )
            .unwrap();
        assert_eq!(
            broker.list_peers("TEST101", &created.host_token).unwrap()[0]
                .answer
                .as_deref(),
            Some("101-answer")
        );
        assert!(broker
            .get_offer("TEST101", &lease.peer_id, &created.host_token)
            .is_err());
    }

    #[test]
    fn reconnect_discards_old_realtime_negotiation() {
        let mut broker = SignalingBroker::default();
        let created = broker
            .create_session(request(), "http://127.0.0.1:10101")
            .unwrap();
        let lease = broker
            .join(
                "TEST101",
                &created.ticket.join_token,
                PairingDevice {
                    device_id: "watch".into(),
                    label: "Watch".into(),
                    capabilities: serde_json::json!({}),
                },
            )
            .unwrap();
        let next = broker
            .reconnect("TEST101", &lease.peer_id, &lease.peer_token, false)
            .unwrap();
        assert_eq!(next.generation, lease.generation + 1);
        assert!(broker
            .get_offer("TEST101", &lease.peer_id, &lease.peer_token)
            .unwrap()
            .offer
            .is_none());
    }
}

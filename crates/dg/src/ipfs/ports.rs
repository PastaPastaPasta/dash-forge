//! Reserve daemon ports while configuring offline, retaining saved swarm choices.
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

use anyhow::Result;
use socket2::{Domain, Socket, Type};

use super::{config::NodeConfig, node_error};

#[derive(Debug)]
pub(super) struct Reservation {
    _sockets: Vec<Socket>,
}

#[derive(Clone, Copy)]
enum Kind {
    Loopback,
    Swarm,
}

fn bind_socket(address: SocketAddr, kind: Type) -> io::Result<Socket> {
    let socket = Socket::new(Domain::for_address(address), kind, None)?;
    // std's TCP listeners enable SO_REUSEADDR on Unix. Disable it so wildcard
    // probes also detect occupied loopback addresses on macOS.
    socket.set_reuse_address(false)?;
    if address.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    socket.bind(&address.into())?;
    if kind == Type::STREAM {
        socket.listen(1)?;
    }
    Ok(socket)
}

fn bind(port: u16, kind: Kind) -> io::Result<Reservation> {
    let mut sockets = Vec::new();
    if matches!(kind, Kind::Swarm) {
        // Hosts without IPv6 can still use kubo's IPv4 listeners. IPv6-only
        // reservations can coexist with IPv4 reservations for the same port.
        if bind_socket((Ipv6Addr::UNSPECIFIED, 0).into(), Type::STREAM).is_ok() {
            sockets.push(bind_socket(
                (Ipv6Addr::UNSPECIFIED, port).into(),
                Type::STREAM,
            )?);
            sockets.push(bind_socket(
                (Ipv6Addr::UNSPECIFIED, port).into(),
                Type::DGRAM,
            )?);
        }
        sockets.push(bind_socket(
            (Ipv4Addr::UNSPECIFIED, port).into(),
            Type::STREAM,
        )?);
        sockets.push(bind_socket(
            (Ipv4Addr::UNSPECIFIED, port).into(),
            Type::DGRAM,
        )?);
    } else {
        sockets.push(bind_socket(
            (Ipv4Addr::LOCALHOST, port).into(),
            Type::STREAM,
        )?);
    }
    Ok(Reservation { _sockets: sockets })
}

fn choose(
    preferred: u16,
    excluded: &[u16],
    fallback: bool,
    kind: Kind,
) -> Result<(u16, Reservation)> {
    let last = if fallback { u16::MAX } else { preferred };
    for port in preferred..=last {
        if excluded.contains(&port) {
            continue;
        }
        match bind(port, kind) {
            Ok(reservation) => return Ok((port, reservation)),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
            Err(error) => {
                return Err(node_error(
                    &format!("cannot probe IPFS port {port}: {error}"),
                    "check local networking permissions and run dg ipfs up again",
                ));
            }
        }
    }
    if !fallback {
        return Err(node_error(
            &format!("IPFS swarm port {preferred} is already in use"),
            "choose a free TCP and UDP port with --swarm-port",
        ));
    }
    Err(node_error(
        "cannot reserve free ports for the IPFS node",
        "stop conflicting programs and run dg ipfs up again",
    ))
}

pub(super) fn warn_change(name: &str, previous: u16, selected: u16) {
    if previous != selected {
        eprintln!("Warning: IPFS {name} port changed from {previous} to {selected}.");
    }
}

fn choose_swarm(config: &NodeConfig) -> Result<(u16, Reservation)> {
    choose(
        config.swarm_port(),
        &[
            config.api_port,
            config.gateway_port,
            config.internal_api_port,
            config.internal_gateway_port,
        ],
        config.swarm_port.is_none(),
        Kind::Swarm,
    )
}

/// Resolve legacy configs before validation, excluding their four existing ports.
pub(super) fn resolve_swarm(config: &mut NodeConfig) -> Result<()> {
    if config.swarm_port.is_none() {
        let (port, _reservation) = choose_swarm(config)?;
        warn_change("swarm", config.swarm_port(), port);
        config.swarm_port = Some(port);
    }
    Ok(())
}

/// Called after our daemon stops, so its own listeners never look like conflicts.
pub(super) fn select(config: &mut NodeConfig) -> Result<[Reservation; 3]> {
    let (swarm_port, swarm) = choose_swarm(config)?;
    let (api_port, api) = choose(
        config.internal_api_port,
        &[
            config.api_port,
            config.gateway_port,
            swarm_port,
            config.internal_gateway_port,
        ],
        true,
        Kind::Loopback,
    )?;
    let (gateway_port, gateway) = choose(
        config.internal_gateway_port,
        &[config.api_port, config.gateway_port, swarm_port, api_port],
        true,
        Kind::Loopback,
    )?;
    warn_change("swarm", config.swarm_port(), swarm_port);
    warn_change("internal API", config.internal_api_port, api_port);
    warn_change(
        "internal gateway",
        config.internal_gateway_port,
        gateway_port,
    );
    config.swarm_port = Some(swarm_port);
    config.internal_api_port = api_port;
    config.internal_gateway_port = gateway_port;
    Ok([api, gateway, swarm])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, UdpSocket};

    #[test]
    fn occupied_internal_ports_move_and_saved_choices_are_reused() {
        let api = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let gateway = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let old_api = api.local_addr().unwrap().port();
        let old_gateway = gateway.local_addr().unwrap().port();
        let mut config = NodeConfig {
            internal_api_port: old_api,
            internal_gateway_port: old_gateway,
            ..Default::default()
        };
        let reservations = select(&mut config).unwrap();
        assert_ne!(config.internal_api_port, old_api);
        assert_ne!(config.internal_gateway_port, old_gateway);
        assert!(config.validate().is_ok());
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, config.internal_api_port)).is_err());
        assert!(UdpSocket::bind((Ipv4Addr::LOCALHOST, config.swarm_port())).is_err());
        let saved = toml::to_string(&config).unwrap();
        drop(reservations);
        let mut restored: NodeConfig = toml::from_str(&saved).unwrap();
        let _reservations = select(&mut restored).unwrap();
        assert_eq!(restored.internal_api_port, config.internal_api_port);
        assert_eq!(restored.internal_gateway_port, config.internal_gateway_port);
        assert_eq!(restored.swarm_port, config.swarm_port);
    }

    #[test]
    fn two_managed_nodes_can_reserve_distinct_daemon_ports() {
        let public_ports: Vec<_> = (0..4)
            .map(|_| TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap())
            .collect();
        let mut first = NodeConfig {
            api_port: public_ports[0].local_addr().unwrap().port(),
            gateway_port: public_ports[1].local_addr().unwrap().port(),
            ..Default::default()
        };
        let mut second = NodeConfig {
            api_port: public_ports[2].local_addr().unwrap().port(),
            gateway_port: public_ports[3].local_addr().unwrap().port(),
            ..Default::default()
        };
        let _first_reservations = select(&mut first).unwrap();
        let _second_reservations = select(&mut second).unwrap();
        assert!(first.validate().is_ok());
        assert!(second.validate().is_ok());
        for port in [
            first.swarm_port(),
            first.internal_api_port,
            first.internal_gateway_port,
        ] {
            assert!(![
                second.swarm_port(),
                second.internal_api_port,
                second.internal_gateway_port,
            ]
            .contains(&port));
        }
    }

    #[test]
    fn swarm_conflicts_check_tcp_and_udp_and_explicit_ports_fail() {
        let tcp = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        for port in [
            tcp.local_addr().unwrap().port(),
            udp.local_addr().unwrap().port(),
        ] {
            let (chosen, _reservation) = choose(port, &[], true, Kind::Swarm).unwrap();
            assert_ne!(chosen, port);
            let error = choose(port, &[], false, Kind::Swarm).unwrap_err();
            let user = error
                .downcast_ref::<forge_core::user_error::UserError>()
                .unwrap();
            assert_eq!(user.code, forge_core::user_error::codes::STORAGE_CONFIG);
            assert!(user.to_json().to_string().contains("--swarm-port"));
        }
    }

    #[test]
    fn swarm_checks_ipv6_when_available() {
        let Ok(tcp) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) else {
            return;
        };
        let port = tcp.local_addr().unwrap().port();
        let (chosen, _reservation) = choose(port, &[], true, Kind::Swarm).unwrap();
        assert_ne!(chosen, port);
        assert!(choose(port, &[], false, Kind::Swarm).is_err());
    }

    #[test]
    fn internal_ports_detect_a_wildcard_listener() {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(bind(port, Kind::Loopback).is_err());
        let (chosen, _reservation) = choose(port, &[], true, Kind::Loopback).unwrap();
        assert!(chosen > port);
    }

    #[test]
    fn fallback_scans_upward_and_skips_excluded_ports() {
        for port in 20_000..60_000 {
            let Ok(first) = bind(port, Kind::Loopback) else {
                continue;
            };
            let Ok(second) = bind(port + 1, Kind::Loopback) else {
                continue;
            };
            let Ok(third) = bind(port + 2, Kind::Loopback) else {
                continue;
            };
            drop(third);
            let (chosen, _reservation) = choose(port, &[port + 1], true, Kind::Loopback).unwrap();
            assert_eq!(chosen, port + 2);
            drop((first, second));
            return;
        }
        panic!("no three consecutive free ports for the scan test");
    }

    #[test]
    fn exhausted_scan_returns_a_user_error_without_wrapping_to_zero() {
        let error = choose(u16::MAX, &[u16::MAX], true, Kind::Loopback).unwrap_err();
        let user = error
            .downcast_ref::<forge_core::user_error::UserError>()
            .unwrap();
        assert_eq!(user.code, forge_core::user_error::codes::STORAGE_CONFIG);
    }

    #[test]
    fn free_preferred_ports_stay_and_fallbacks_exclude_other_node_ports() {
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let (chosen, reservation) = choose(port, &[], true, Kind::Loopback).unwrap();
        assert_eq!(chosen, port);
        drop(reservation);
        let (chosen, _reservation) = choose(port, &[port], true, Kind::Loopback).unwrap();
        assert_ne!(chosen, port);
        assert!(choose(port, &[port], false, Kind::Swarm).is_err());
    }
}

//! Reserve daemon ports while configuring offline, retaining saved choices when free.
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener, UdpSocket};

use anyhow::Result;

use super::{config::NodeConfig, node_error};

#[derive(Debug)]
pub(super) struct Reservation {
    _tcp: TcpListener,
    _udp: Option<UdpSocket>,
}

#[derive(Clone, Copy)]
enum Kind {
    Loopback,
    Swarm,
}

fn bind(port: u16, kind: Kind) -> io::Result<Reservation> {
    if matches!(kind, Kind::Swarm) {
        // Probe IPv6 separately: its wildcard listener may also bind IPv4 on this OS.
        // Hosts without IPv6 can still use kubo's IPv4 listeners.
        if TcpListener::bind((Ipv6Addr::UNSPECIFIED, 0)).is_ok() {
            let tcp = TcpListener::bind((Ipv6Addr::UNSPECIFIED, port))?;
            let udp = UdpSocket::bind((Ipv6Addr::UNSPECIFIED, port))?;
            drop((tcp, udp));
        }
        Ok(Reservation {
            _tcp: TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))?,
            _udp: Some(UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port))?),
        })
    } else {
        Ok(Reservation {
            _tcp: TcpListener::bind((Ipv4Addr::LOCALHOST, port))?,
            _udp: None,
        })
    }
}

fn choose(
    preferred: u16,
    excluded: &[u16],
    fallback: bool,
    kind: Kind,
) -> Result<(u16, Reservation)> {
    if !excluded.contains(&preferred) {
        if let Ok(reservation) = bind(preferred, kind) {
            return Ok((preferred, reservation));
        }
    }
    if !fallback {
        return Err(node_error(
            &format!("IPFS swarm port {preferred} is already in use"),
            "choose a free TCP and UDP port with --swarm-port",
        ));
    }
    // An ephemeral TCP choice can still conflict with UDP or IPv6; retry boundedly.
    for _ in 0..32 {
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = probe.local_addr()?.port();
        if excluded.contains(&port) {
            continue;
        }
        drop(probe);
        if let Ok(reservation) = bind(port, kind) {
            return Ok((port, reservation));
        }
    }
    Err(node_error(
        "cannot reserve free ports for the IPFS node",
        "stop conflicting programs and run dg ipfs up again",
    ))
}

/// Called after our daemon stops, so its own listeners never look like conflicts.
pub(super) fn select(config: &mut NodeConfig, swarm_explicit: bool) -> Result<[Reservation; 3]> {
    let (swarm_port, swarm) = choose(
        config.swarm_port,
        &[
            config.api_port,
            config.gateway_port,
            config.internal_api_port,
            config.internal_gateway_port,
        ],
        !swarm_explicit,
        Kind::Swarm,
    )?;
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
    config.swarm_port = swarm_port;
    config.internal_api_port = api_port;
    config.internal_gateway_port = gateway_port;
    Ok([api, gateway, swarm])
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let reservations = select(&mut config, false).unwrap();
        assert_ne!(config.internal_api_port, old_api);
        assert_ne!(config.internal_gateway_port, old_gateway);
        assert!(config.validate().is_ok());
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, config.internal_api_port)).is_err());
        assert!(UdpSocket::bind((Ipv4Addr::LOCALHOST, config.swarm_port)).is_err());
        let saved = toml::to_string(&config).unwrap();
        drop(reservations);
        let mut restored: NodeConfig = toml::from_str(&saved).unwrap();
        let _reservations = select(&mut restored, false).unwrap();
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
        let _first_reservations = select(&mut first, false).unwrap();
        let _second_reservations = select(&mut second, false).unwrap();
        assert!(first.validate().is_ok());
        assert!(second.validate().is_ok());
        for port in [
            first.swarm_port,
            first.internal_api_port,
            first.internal_gateway_port,
        ] {
            assert!(![
                second.swarm_port,
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

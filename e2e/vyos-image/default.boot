interfaces {
    ethernet eth1 {
        ipv6 {
            address {
                no-default-link-local
            }
        }
    }
    ethernet eth2 {
        ipv6 {
            address {
                no-default-link-local
            }
        }
    }
    ethernet eth3 {
        ipv6 {
            address {
                no-default-link-local
            }
        }
    }
    loopback lo {
    }
}
service {
    https {
        listen-address "0.0.0.0"
        api {
            keys {
                id vygi {
                    key "vygi-test-key"
                }
            }
            rest {
            }
        }
    }
    ssh {
    }
    ntp {
        allow-client {
            address "127.0.0.0/8"
            address "169.254.0.0/16"
            address "10.0.0.0/8"
            address "172.16.0.0/12"
            address "192.168.0.0/16"
            address "::1/128"
            address "fe80::/10"
            address "fc00::/7"
        }
        server time1.vyos.net {
        }
        server time2.vyos.net {
        }
        server time3.vyos.net {
        }
    }
}
system {
    config-management {
        commit-revisions "100"
    }
    host-name "vyos"
    login {
        operator-group default {
            command-policy {
                allow "*"
            }
        }
        user vyos {
            authentication {
                encrypted-password "$6$QxPS.uk6mfo$9QBSo8u1FkH16gMyAVhus6fU3LOzvLR9Z9.82m3tiHFAxTtIkhaZSWssSgzt4v4dGAL8rhVQxTg0oAG9/q11h/"
                plaintext-password ""
            }
        }
    }
    option {
        reboot-on-upgrade-failure "5"
    }
    syslog {
        local {
            facility all {
                level "info"
            }
            facility local7 {
                level "debug"
            }
        }
    }
}


// Warning: Do not remove the following line.
// vyos-config-version: "bgp@8:broadcast-relay@1:cluster@2:config-management@2:conntrack@6:conntrack-sync@2:container@3:dhcp-relay@2:dhcp-server@11:dhcpv6-server@6:dns-dynamic@5:dns-forwarding@4:firewall@20:flow-accounting@3:https@7:ids@2:interfaces@34:ipoe-server@4:ipsec@14:isis@3:l2tp@10:lldp@3:mdns@1:monitoring@2:nat@8:nat66@3:nhrp@1:ntp@3:openconnect@3:openvpn@6:ospf@3:pim@1:pki@1:policy@9:pppoe-server@13:pptp@6:qos@3:quagga@12:reverse-proxy@3:rip@1:rpki@2:snmp@3:ssh@3:sstp@7:system@33:vpp@6:vrf@4:vrrp@4:vyos-accel-ppp@2:wanloadbalance@4:webproxy@2"
// Release version: 2026.10.23-0026-rolling

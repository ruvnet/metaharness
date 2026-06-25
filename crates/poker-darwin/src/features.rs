// SPDX-License-Identifier: MIT
//
// Interpretable featurization of information-set keys, shared by the ruvector
// abstraction and the candle policy net. Keeping it dependency-free and always
// compiled means both integrations consume identical features (so an abstraction
// bucket and a network prediction are directly comparable).

/// Featurize a canonical information-set key into an interpretable vector.
/// Works for both Kuhn ("J:pb") and Leduc ("J|cr|Q|c") keys:
///   [own card, has board, board rank, #bets/raises, #calls/checks, #folds, len]
pub fn featurize(key: &str) -> Vec<f32> {
    let rank = |c: char| match c {
        'J' => Some(0.0),
        'Q' => Some(1.0),
        'K' => Some(2.0),
        _ => None,
    };
    let mut card = 0.0;
    let mut board = 0.0;
    let mut has_board = 0.0;
    let mut seen_card = false;
    let (mut bets, mut calls, mut folds, mut len) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for ch in key.chars() {
        if let Some(r) = rank(ch) {
            if !seen_card {
                card = r;
                seen_card = true;
            } else {
                board = r;
                has_board = 1.0;
            }
            continue;
        }
        match ch {
            'b' | 'r' => {
                bets += 1.0;
                len += 1.0;
            }
            'c' | 'p' => {
                calls += 1.0;
                len += 1.0;
            }
            'f' => {
                folds += 1.0;
                len += 1.0;
            }
            _ => {}
        }
    }
    vec![card, has_board, board, bets, calls, folds, len]
}

/// Dimensionality of [`featurize`] output.
pub const FEATURE_DIM: usize = 7;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_card_and_board() {
        let a = featurize("J|cr|Q|c");
        let b = featurize("J|cr|K|c");
        assert_ne!(a, b);
        assert_eq!(a.len(), FEATURE_DIM);
        assert_eq!(a[0], 0.0); // card J
        assert_eq!(a[1], 1.0); // has board
    }

    #[test]
    fn kuhn_key_has_no_board() {
        let f = featurize("K:pb");
        assert_eq!(f[1], 0.0, "Kuhn keys have no board card");
        assert_eq!(f[0], 2.0); // card K
    }
}

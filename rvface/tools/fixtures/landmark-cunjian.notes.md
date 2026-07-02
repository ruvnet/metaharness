# cunjian/pytorch_face_landmark — reference preprocessing for the 68-pt MobileFaceNet

Source inspected: `test_batch_detections.py` at
https://raw.githubusercontent.com/cunjian/pytorch_face_landmark/master/test_batch_detections.py
(the repo has no `test_camera_mobilefacenet.py`; this batch script is the
MobileFaceNet inference reference, `--backbone MobileFaceNet` default).

Model construction: `MobileFaceNet([112, 112], 136)` loading
`checkpoint/mobilefacenet_model_best.pth.tar` (`checkpoint['state_dict']`).

Per detected face box `(x1, y1, x2, y2)` on the ORIGINAL image:

1. `w = x2 - x1 + 1`, `h = y2 - y1 + 1`
2. crop enlargement: `size = int(min(w, h) * 1.2)`
3. square box centered on the ORIGINAL box center computed with integer
   floor-division: `cx = x1 + w // 2`, `cy = y1 + h // 2`,
   `x1' = cx - size // 2`, `x2' = x1' + size` (same for y)
4. the square is clipped to the image; the clipped-off amounts
   `(dx, dy, edx, edy)` are re-added as ZERO padding via
   `cv2.copyMakeBorder(..., cv2.BORDER_CONSTANT, 0)` so the network always
   sees the full square
5. resize to 112x112 with `cv2.resize` default interpolation (bilinear)
6. normalization: `crop / 255.0` — NO mean subtraction, NO std division
   (the mean/std branch applies to the MobileNet backbone only)
7. channel order: the crop comes from `cv2.imread` and is never converted,
   so the network input is BGR; layout HWC -> CHW -> 1x3x112x112 float32
8. inference: `landmark = model(input)[0]` (first element of the
   (landmarks, conv_features) tuple), reshaped to 68x2
9. re-projection to image coordinates: `x = x_norm * square_w + x1'`,
   `y = y_norm * square_h + y1'` (BBox.reprojectLandmark), i.e. the raw
   network output is normalized [0,1] coordinates inside the padded square

rvFACE follows this exactly for the landmark stage (ADR-0004 "GetLandmark:
follows the checkpoint's reference preprocessing").

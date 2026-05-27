import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import Graph from 'graphology';
import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force-3d';
import { SigmaEdgeAttributes, SigmaNodeAttributes } from '../lib/graph-adapter';
import { GRAPH_SURFACE_COLORS, type EdgeType } from '../lib/constants';
import {
  brightenColor,
  mixColor,
  resolveGraphEdgeVisual,
  resolveGraphNodeVisual,
} from '../lib/graph-visual-state';
import {
  GRAPH_PERF_METRICS,
  recordGraphPerf,
  startGraphPerfMeasure,
  type GraphPerfObserver,
} from '../lib/graph-perf';
import { shouldPublishThreeLayoutPositions } from '../lib/graph-layout-policy';
import { getRelationCurveMultiplier, hashToUnit } from '../lib/graph-render-model';
import type { NodeAnimation } from './useAppState';

export {
  THREE_LAYOUT_POSITION_PUBLISH_INTERVAL_MS,
  shouldPublishThreeLayoutPositions,
} from '../lib/graph-layout-policy';

export type ThreeGraphCameraMode = 'arcball' | 'firstPerson';

interface UseThreeGraphOptions {
  isActive?: boolean;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onStageClick?: () => void;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
  animatedNodes?: Map<string, NodeAnimation>;
  visibleEdgeTypes?: EdgeType[];
  perfObserver?: GraphPerfObserver;
}

interface UseThreeGraphReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  setGraph: (
    graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
    options?: ThreeSetGraphOptions,
  ) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusNode: (nodeId: string) => void;
  isLayoutRunning: boolean;
  startLayout: () => void;
  stopLayout: () => void;
  selectedNode: string | null;
  setSelectedNode: (nodeId: string | null) => void;
  refreshHighlights: () => void;
  cameraMode: ThreeGraphCameraMode;
  setCameraMode: (mode: ThreeGraphCameraMode) => void;
}

interface ThreeSetGraphOptions {
  runLayout?: boolean;
  resetCamera?: boolean;
  clearSelection?: boolean;
  preservePositions?: boolean;
}

type ArcballWithTarget = ArcballControls & { target: THREE.Vector3 };

interface Graph3DNode extends SimulationNodeDatum {
  id: string;
  attributes: SigmaNodeAttributes;
}

interface Graph3DLink extends SimulationLinkDatum<Graph3DNode> {
  id: string;
  sourceId: string;
  targetId: string;
  attributes: SigmaEdgeAttributes;
  curveVector: THREE.Vector3;
  curveMultiplier: number;
}

type EdgeRenderEntry = {
  link: Graph3DLink;
  source: Graph3DNode;
  target: Graph3DNode;
  base: number;
  span: number;
  curveVectorX: number;
  curveVectorY: number;
  curveVectorZ: number;
  curveMultiplier: number;
};

type NodeVisual = {
  visible: boolean;
  color: string;
  scale: number;
  haloScale: number;
  shellScale: number;
  shellColor: string;
};

type ColorComponents = {
  r: number;
  g: number;
  b: number;
};

type HoverPickRequest = {
  clientX: number;
  clientY: number;
};

type SceneDirtyFlags = {
  nodeTransforms: boolean;
  nodeVisuals: boolean;
  sparkPositions: boolean;
  sparkVisuals: boolean;
  edgePositions: boolean;
  edgeVisuals: boolean;
  cameraBillboards: boolean;
  animation: boolean;
};

const createSceneDirtyFlags = (dirty = false): SceneDirtyFlags => ({
  nodeTransforms: dirty,
  nodeVisuals: dirty,
  sparkPositions: dirty,
  sparkVisuals: dirty,
  edgePositions: dirty,
  edgeVisuals: dirty,
  cameraBillboards: dirty,
  animation: dirty,
});

const BACKGROUND_COLOR = GRAPH_SURFACE_COLORS.background;
const MAX_DEVICE_PIXEL_RATIO = 2;
const INTERACTION_DEVICE_PIXEL_RATIO_CAP = 1.25;
const INTERACTION_DPR_RESTORE_MS = 240;
const HOVER_POINTER_MOVE_THRESHOLD_PX = 3;
const HOVER_DRAG_THRESHOLD_PX = 5;
const HOVER_CAMERA_IDLE_MS = 90;
const CAMERA_POSITION_MOVEMENT_THRESHOLD_SQ = 0.01;
const CAMERA_ROTATION_MOVEMENT_THRESHOLD = 0.0005;
const EDGE_CURVE_SEGMENTS = 5;
const WHITE_COLOR = new THREE.Color('#ffffff');
const SCRATCH_SOURCE = new THREE.Vector3();
const SCRATCH_TARGET = new THREE.Vector3();
const SCRATCH_MID = new THREE.Vector3();
const SCRATCH_DIRECTION = new THREE.Vector3();
const SCRATCH_BEND = new THREE.Vector3();
const SCRATCH_CONTROL = new THREE.Vector3();
const SCRATCH_POINT_A = new THREE.Vector3();
const SCRATCH_POINT_B = new THREE.Vector3();
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();
const IDENTITY_QUATERNION = new THREE.Quaternion();

const createRadialTexture = (stops: Array<[number, string]>): THREE.CanvasTexture => {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');

  if (context) {
    const radius = size / 2;
    const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
    stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const disposeMaterial = (material: THREE.Material | THREE.Material[]): void => {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((item) => {
    Object.values(item).forEach((value) => {
      if (value && typeof value === 'object' && 'isTexture' in value) {
        (value as THREE.Texture).dispose();
      }
    });
    item.dispose();
  });
};

const setQuadraticPoint = (
  target: THREE.Vector3,
  source: THREE.Vector3,
  control: THREE.Vector3,
  end: THREE.Vector3,
  t: number,
): THREE.Vector3 => {
  const inverse = 1 - t;
  const sourceWeight = inverse * inverse;
  const controlWeight = 2 * inverse * t;
  const endWeight = t * t;

  target.set(
    source.x * sourceWeight + control.x * controlWeight + end.x * endWeight,
    source.y * sourceWeight + control.y * controlWeight + end.y * endWeight,
    source.z * sourceWeight + control.z * controlWeight + end.z * endWeight,
  );

  return target;
};

const getNodeGeometrySegments = (nodeCount: number): number => {
  if (nodeCount > 5000) return 10;
  if (nodeCount > 1500) return 12;
  return 16;
};

const getLayoutAlphaDecay = (nodeCount: number): number => {
  if (nodeCount > 10000) return 0.003;
  if (nodeCount > 5000) return 0.0038;
  if (nodeCount > 2000) return 0.005;
  if (nodeCount > 1000) return 0.0065;
  if (nodeCount > 500) return 0.009;
  return 0.012;
};

const getHoverPickCadenceMs = (nodeCount: number): number => {
  if (nodeCount > 5000) return 80;
  if (nodeCount > 1500) return 48;
  return 0;
};

const getNodePosition = (node: Graph3DNode): THREE.Vector3 => {
  return new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0);
};

const getCachedColorComponents = (
  cache: Map<string, ColorComponents>,
  colorValue: string,
): ColorComponents => {
  let cached = cache.get(colorValue);
  if (!cached) {
    SCRATCH_COLOR.set(colorValue);
    cached = { r: SCRATCH_COLOR.r, g: SCRATCH_COLOR.g, b: SCRATCH_COLOR.b };
    cache.set(colorValue, cached);
  }
  return cached;
};

const setInstancedColorFromCache = (
  mesh: THREE.InstancedMesh,
  index: number,
  cache: Map<string, ColorComponents>,
  colorValue: string,
): void => {
  const color = getCachedColorComponents(cache, colorValue);
  SCRATCH_COLOR.setRGB(color.r, color.g, color.b);
  mesh.setColorAt(index, SCRATCH_COLOR);
};

const isEdgeRenderEntryVisible = (
  entry: EdgeRenderEntry,
  visibleTypes: Set<EdgeType> | null,
): boolean => {
  const relationType = entry.link.attributes.relationType;
  const hiddenByType = relationType
    ? Boolean(visibleTypes && !visibleTypes.has(relationType as EdgeType))
    : false;

  return !entry.source.attributes.hidden && !entry.target.attributes.hidden && !hiddenByType;
};

const getCameraTarget = (
  nodes: Graph3DNode[],
  fallback = new THREE.Vector3(),
): { center: THREE.Vector3; radius: number } => {
  if (nodes.length === 0) return { center: fallback, radius: 100 };

  const box = new THREE.Box3();
  for (const node of nodes) {
    const attrs = node.attributes;
    if (attrs.hidden) continue;
    box.expandByPoint(getNodePosition(node));
  }

  if (box.isEmpty()) {
    for (const node of nodes) box.expandByPoint(getNodePosition(node));
  }

  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);

  return {
    center: sphere.center.lengthSq() > 0 ? sphere.center : fallback,
    radius: Math.max(80, sphere.radius || 100),
  };
};

export const useThreeGraph = (options: UseThreeGraphOptions = {}): UseThreeGraphReturn => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const arcballRef = useRef<ArcballWithTarget | null>(null);
  const pointerLockRef = useRef<PointerLockControls | null>(null);
  const nodeMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const haloMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const shellMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const sparkPointsRef = useRef<THREE.Points | null>(null);
  const edgeLinesRef = useRef<THREE.LineSegments | null>(null);
  const graphRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const nodesRef = useRef<Graph3DNode[]>([]);
  const nodeIndexRef = useRef<Map<string, Graph3DNode>>(new Map());
  const linksRef = useRef<Graph3DLink[]>([]);
  const edgeRenderEntriesRef = useRef<EdgeRenderEntry[]>([]);
  const simulationRef = useRef<Simulation<Graph3DNode, Graph3DLink> | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const highlightedRef = useRef<Set<string>>(new Set());
  const blastRadiusRef = useRef<Set<string>>(new Set());
  const animatedNodesRef = useRef<Map<string, NodeAnimation>>(new Map());
  const visibleEdgeTypeSetRef = useRef<Set<EdgeType> | null>(null);
  const cameraModeRef = useRef<ThreeGraphCameraMode>('arcball');
  const optionsRef = useRef(options);
  const isActiveRef = useRef(options.isActive ?? true);
  const keyStateRef = useRef<Set<string>>(new Set());
  const animationFrameRef = useRef<number | null>(null);
  const resumeAnimationLoopRef = useRef<(() => void) | null>(null);
  const pauseAnimationLoopRef = useRef<(() => void) | null>(null);
  const edgePositionsRef = useRef<Float32Array | null>(null);
  const edgeColorsRef = useRef<Float32Array | null>(null);
  const sparkPositionsRef = useRef<Float32Array | null>(null);
  const sparkColorsRef = useRef<Float32Array | null>(null);
  const nodeVisualsRef = useRef<NodeVisual[]>([]);
  const colorComponentsCacheRef = useRef<Map<string, ColorComponents>>(new Map());
  const sceneDirtyRef = useRef<SceneDirtyFlags>(createSceneDirtyFlags(true));
  const lastCameraQuaternionRef = useRef(new THREE.Quaternion());
  const layoutRunningRef = useRef(false);
  const lastLayoutPositionPublishRef = useRef<number | null>(null);
  const lastTimeRef = useRef(performance.now());
  const renderPendingRef = useRef(false);

  const [selectedNode, setSelectedNodeState] = useState<string | null>(null);
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [cameraMode, setCameraModeState] = useState<ThreeGraphCameraMode>('arcball');

  useEffect(() => {
    optionsRef.current = options;
    isActiveRef.current = options.isActive ?? true;
  }, [options]);

  const isRendererActive = useCallback(() => isActiveRef.current, []);

  const markSceneDirty = useCallback((flags: Partial<SceneDirtyFlags>) => {
    Object.assign(sceneDirtyRef.current, flags);
  }, []);

  const markSceneFullyDirty = useCallback(() => {
    sceneDirtyRef.current = createSceneDirtyFlags(true);
  }, []);

  const markGraphVisualsDirty = useCallback(
    (includeVisibility = false) => {
      const dirtyFlags: Partial<SceneDirtyFlags> = {
        nodeVisuals: true,
        edgeVisuals: true,
      };

      if (includeVisibility) {
        dirtyFlags.edgePositions = true;
      }

      markSceneDirty(dirtyFlags);
    },
    [markSceneDirty],
  );

  const markGraphPositionsDirty = useCallback(() => {
    markSceneDirty({
      nodeTransforms: true,
      sparkPositions: true,
      edgePositions: true,
    });
  }, [markSceneDirty]);

  const publishLayoutPositions = useCallback(
    (label: string, options: { force?: boolean; nowMs?: number } = {}) => {
      const nowMs = options.nowMs ?? performance.now();
      const shouldPublish =
        options.force === true ||
        shouldPublishThreeLayoutPositions(nowMs, lastLayoutPositionPublishRef.current);

      recordGraphPerf(optionsRef.current.perfObserver, GRAPH_PERF_METRICS.threeSceneUpdate, {
        label: `layout-publish:${shouldPublish ? 'published' : 'throttled'}:${label}`,
      });

      if (!shouldPublish) return false;

      lastLayoutPositionPublishRef.current = nowMs;
      markGraphPositionsDirty();
      return true;
    },
    [markGraphPositionsDirty],
  );

  const setSelectedNode = useCallback(
    (nodeId: string | null) => {
      selectedNodeRef.current = nodeId;
      setSelectedNodeState(nodeId);
      markGraphVisualsDirty(false);
    },
    [markGraphVisualsDirty],
  );

  const createNodeVisual = useCallback(
    (
      color: string,
      scale: number,
      emphasis = 0.35,
      shell = false,
      shellColor = color,
    ): NodeVisual => {
      const lift = 0.06 + Math.max(0, Math.min(1, emphasis)) * 0.18;
      const displayColor = mixColor(color, '#f8fbff', lift);

      return {
        visible: true,
        color: displayColor,
        scale,
        haloScale: scale * (1.72 + emphasis * 1.28),
        shellScale: shell ? scale * (2.12 + emphasis * 0.5) : 0,
        shellColor: mixColor(shellColor, '#ffffff', 0.18),
      };
    },
    [],
  );

  const getNodeVisual = useCallback(
    (nodeId: string, attributes: SigmaNodeAttributes, now: number): NodeVisual => {
      if (attributes.hidden) {
        return {
          visible: false,
          color: attributes.color,
          scale: 0,
          haloScale: 0,
          shellScale: 0,
          shellColor: attributes.color,
        };
      }

      const graph = graphRef.current;
      const currentSelected = selectedNodeRef.current;
      const currentHovered = hoveredNodeRef.current;
      const baseSize = Math.max(2.4, (attributes.size || 4) * 1.9);
      const visual = resolveGraphNodeVisual({
        nodeId,
        color: attributes.color,
        size: baseSize,
        selectedNodeId: currentSelected,
        hoveredNodeId: currentHovered,
        highlightedNodeIds: highlightedRef.current,
        blastRadiusNodeIds: blastRadiusRef.current,
        animatedNodes: animatedNodesRef.current,
        isNeighbor: currentSelected
          ? Boolean(
              graph?.hasEdge(nodeId, currentSelected) || graph?.hasEdge(currentSelected, nodeId),
            )
          : false,
        now,
      });

      return createNodeVisual(
        visual.color,
        visual.size,
        visual.emphasis,
        visual.shell,
        visual.shellColor,
      );
    },
    [createNodeVisual],
  );

  const updateSceneObjects = useCallback(
    (label = 'unspecified'): boolean => {
      if (!isRendererActive()) return false;

      const dirty = sceneDirtyRef.current;
      if (animatedNodesRef.current.size > 0) {
        const checkNow = Date.now();
        for (const anim of animatedNodesRef.current.values()) {
          if (checkNow < anim.startTime + anim.duration) {
            dirty.animation = true;
            dirty.nodeVisuals = true;
            break;
          }
        }
      }

      const camera = cameraRef.current;
      if (camera && !lastCameraQuaternionRef.current.equals(camera.quaternion)) {
        dirty.cameraBillboards = true;
      }
      if (dirty.nodeVisuals) {
        dirty.nodeTransforms = true;
        dirty.sparkVisuals = true;
      }
      if (dirty.cameraBillboards) {
        dirty.nodeTransforms = true;
      }
      if (!Object.values(dirty).some(Boolean)) return false;

      const finishSceneUpdate = startGraphPerfMeasure(
        optionsRef.current.perfObserver,
        GRAPH_PERF_METRICS.threeSceneUpdate,
        { label },
      );
      const finishSceneUpdateCategory = (category: string): (() => void) =>
        startGraphPerfMeasure(
          optionsRef.current.perfObserver,
          GRAPH_PERF_METRICS.threeSceneUpdate,
          { label: `${label}:${category}` },
        );
      const nodeMesh = nodeMeshRef.current;
      const haloMesh = haloMeshRef.current;
      const shellMesh = shellMeshRef.current;
      const sparkPoints = sparkPointsRef.current;
      const edgeLines = edgeLinesRef.current;
      const graph = graphRef.current;
      if (!nodeMesh || !haloMesh || !shellMesh || !sparkPoints || !edgeLines || !graph) {
        finishSceneUpdate();
        return false;
      }

      const nodes = nodesRef.current;
      const nodeVisuals = nodeVisualsRef.current;
      const sparkPositions = sparkPositionsRef.current;
      const sparkColors = sparkColorsRef.current;
      const colorCache = colorComponentsCacheRef.current;

      if (dirty.nodeVisuals) {
        const finishNodeVisuals = finishSceneUpdateCategory('node-visuals');
        const now = Date.now();
        nodeVisuals.length = nodes.length;

        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          const visual = getNodeVisual(node.id, node.attributes, now);
          nodeVisuals[i] = visual;

          setInstancedColorFromCache(nodeMesh, i, colorCache, visual.color);
          setInstancedColorFromCache(haloMesh, i, colorCache, brightenColor(visual.color, 1.45));
          setInstancedColorFromCache(shellMesh, i, colorCache, visual.shellColor);
        }

        if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
        if (haloMesh.instanceColor) haloMesh.instanceColor.needsUpdate = true;
        if (shellMesh.instanceColor) shellMesh.instanceColor.needsUpdate = true;
        dirty.nodeVisuals = false;
        finishNodeVisuals();
      }

      if (dirty.nodeTransforms) {
        const finishNodeTransforms = finishSceneUpdateCategory('node-transforms');
        const now = Date.now();
        const matrix = SCRATCH_MATRIX;
        const position = SCRATCH_POSITION;
        const scale = SCRATCH_SCALE;
        const billboardQuaternion = cameraRef.current?.quaternion || IDENTITY_QUATERNION;

        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          const visual = nodeVisuals[i] || getNodeVisual(node.id, node.attributes, now);
          position.set(node.x || 0, node.y || 0, node.z || 0);

          scale.set(visual.scale, visual.scale, visual.scale);
          matrix.compose(position, billboardQuaternion, scale);
          nodeMesh.setMatrixAt(i, matrix);

          scale.set(visual.haloScale, visual.haloScale, visual.haloScale);
          matrix.compose(position, billboardQuaternion, scale);
          haloMesh.setMatrixAt(i, matrix);

          scale.set(visual.shellScale, visual.shellScale, visual.shellScale);
          matrix.compose(position, billboardQuaternion, scale);
          shellMesh.setMatrixAt(i, matrix);
        }

        nodeMesh.instanceMatrix.needsUpdate = true;
        haloMesh.instanceMatrix.needsUpdate = true;
        shellMesh.instanceMatrix.needsUpdate = true;
        if (cameraRef.current) lastCameraQuaternionRef.current.copy(cameraRef.current.quaternion);
        dirty.nodeTransforms = false;
        dirty.cameraBillboards = false;
        finishNodeTransforms();
      }

      if (dirty.sparkPositions && sparkPositions) {
        const finishSparkPositions = finishSceneUpdateCategory('spark-positions');
        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          const sparkBase = i * 3;
          sparkPositions[sparkBase] = node.x || 0;
          sparkPositions[sparkBase + 1] = node.y || 0;
          sparkPositions[sparkBase + 2] = node.z || 0;
        }

        const sparkPositionAttr = sparkPoints.geometry.getAttribute(
          'position',
        ) as THREE.BufferAttribute;
        sparkPositionAttr.needsUpdate = true;
        dirty.sparkPositions = false;
        finishSparkPositions();
      }

      if (dirty.sparkVisuals && sparkColors) {
        const finishSparkVisuals = finishSceneUpdateCategory('spark-visuals');
        const now = Date.now();
        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          const visual = nodeVisuals[i] || getNodeVisual(node.id, node.attributes, now);
          const sparkBase = i * 3;
          if (visual.visible) {
            const color = getCachedColorComponents(colorCache, visual.color);
            sparkColors[sparkBase] = color.r + (1 - color.r) * 0.18;
            sparkColors[sparkBase + 1] = color.g + (1 - color.g) * 0.18;
            sparkColors[sparkBase + 2] = color.b + (1 - color.b) * 0.18;
          } else {
            sparkColors[sparkBase] = 0;
            sparkColors[sparkBase + 1] = 0;
            sparkColors[sparkBase + 2] = 0;
          }
        }

        const sparkColorAttr = sparkPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
        sparkColorAttr.needsUpdate = true;
        dirty.sparkVisuals = false;
        finishSparkVisuals();
      }

      const positions = edgePositionsRef.current;
      const colors = edgeColorsRef.current;
      if ((dirty.edgePositions && !positions) || (dirty.edgeVisuals && !colors)) {
        finishSceneUpdate();
        return false;
      }

      const visibleTypes = visibleEdgeTypeSetRef.current;
      const edgeRenderEntries = edgeRenderEntriesRef.current;

      if (dirty.edgePositions && positions) {
        const finishEdgePositions = finishSceneUpdateCategory('edge-positions');
        for (let i = 0; i < edgeRenderEntries.length; i += 1) {
          const entry = edgeRenderEntries[i];
          const source = entry.source;
          const target = entry.target;

          if (!isEdgeRenderEntryVisible(entry, visibleTypes)) {
            positions.fill(0, entry.base, entry.base + entry.span);
            continue;
          }

          SCRATCH_SOURCE.set(source.x || 0, source.y || 0, source.z || 0);
          SCRATCH_TARGET.set(target.x || 0, target.y || 0, target.z || 0);
          SCRATCH_MID.copy(SCRATCH_SOURCE).add(SCRATCH_TARGET).multiplyScalar(0.5);
          SCRATCH_DIRECTION.copy(SCRATCH_TARGET).sub(SCRATCH_SOURCE);
          const distance = Math.max(1, SCRATCH_DIRECTION.length());
          SCRATCH_DIRECTION.divideScalar(distance);

          SCRATCH_BEND.set(entry.curveVectorX, entry.curveVectorY, entry.curveVectorZ);
          SCRATCH_BEND.addScaledVector(SCRATCH_DIRECTION, -SCRATCH_BEND.dot(SCRATCH_DIRECTION));
          if (SCRATCH_BEND.lengthSq() < 0.0001) {
            SCRATCH_BEND.set(0, 1, 0).addScaledVector(SCRATCH_DIRECTION, -SCRATCH_DIRECTION.y);
          }
          SCRATCH_BEND.normalize();

          const arcHeight = Math.min(125, Math.max(10, distance * entry.curveMultiplier));
          SCRATCH_CONTROL.copy(SCRATCH_MID).addScaledVector(SCRATCH_BEND, arcHeight);

          for (let segment = 0; segment < EDGE_CURVE_SEGMENTS; segment += 1) {
            const startT = segment / EDGE_CURVE_SEGMENTS;
            const endT = (segment + 1) / EDGE_CURVE_SEGMENTS;
            setQuadraticPoint(
              SCRATCH_POINT_A,
              SCRATCH_SOURCE,
              SCRATCH_CONTROL,
              SCRATCH_TARGET,
              startT,
            );
            setQuadraticPoint(
              SCRATCH_POINT_B,
              SCRATCH_SOURCE,
              SCRATCH_CONTROL,
              SCRATCH_TARGET,
              endT,
            );

            const segmentBase = entry.base + segment * 6;
            positions[segmentBase] = SCRATCH_POINT_A.x;
            positions[segmentBase + 1] = SCRATCH_POINT_A.y;
            positions[segmentBase + 2] = SCRATCH_POINT_A.z;
            positions[segmentBase + 3] = SCRATCH_POINT_B.x;
            positions[segmentBase + 4] = SCRATCH_POINT_B.y;
            positions[segmentBase + 5] = SCRATCH_POINT_B.z;
          }
        }

        const positionAttr = edgeLines.geometry.getAttribute('position') as THREE.BufferAttribute;
        positionAttr.needsUpdate = true;
        dirty.edgePositions = false;
        finishEdgePositions();
      }

      if (dirty.edgeVisuals && colors) {
        const finishEdgeVisuals = finishSceneUpdateCategory('edge-visuals');
        const highlighted = highlightedRef.current;
        const blastRadius = blastRadiusRef.current;
        const currentSelected = selectedNodeRef.current;

        for (let i = 0; i < edgeRenderEntries.length; i += 1) {
          const entry = edgeRenderEntries[i];
          const link = entry.link;

          if (!isEdgeRenderEntryVisible(entry, visibleTypes)) {
            colors.fill(0, entry.base, entry.base + entry.span);
            continue;
          }

          const edgeVisual = resolveGraphEdgeVisual({
            sourceId: link.sourceId,
            targetId: link.targetId,
            color: link.attributes.color || GRAPH_SURFACE_COLORS.fallbackEdge,
            size: link.attributes.size || 1,
            selectedNodeId: currentSelected,
            highlightedNodeIds: highlighted,
            blastRadiusNodeIds: blastRadius,
          });

          const color = getCachedColorComponents(colorCache, edgeVisual.color);
          const highlightR = color.r + (WHITE_COLOR.r - color.r) * 0.34;
          const highlightG = color.g + (WHITE_COLOR.g - color.g) * 0.34;
          const highlightB = color.b + (WHITE_COLOR.b - color.b) * 0.34;

          for (let segment = 0; segment < EDGE_CURVE_SEGMENTS; segment += 1) {
            const segmentBase = entry.base + segment * 6;
            const distanceFromMiddle = Math.abs((segment + 0.5) / EDGE_CURVE_SEGMENTS - 0.5) * 2;
            const useHighlight = distanceFromMiddle < 0.42;
            const r = useHighlight ? highlightR : color.r;
            const g = useHighlight ? highlightG : color.g;
            const b = useHighlight ? highlightB : color.b;
            colors[segmentBase] = r;
            colors[segmentBase + 1] = g;
            colors[segmentBase + 2] = b;
            colors[segmentBase + 3] = r;
            colors[segmentBase + 4] = g;
            colors[segmentBase + 5] = b;
          }
        }

        const colorAttr = edgeLines.geometry.getAttribute('color') as THREE.BufferAttribute;
        colorAttr.needsUpdate = true;
        dirty.edgeVisuals = false;
        finishEdgeVisuals();
      }

      dirty.animation = false;
      finishSceneUpdate();
      renderPendingRef.current = true;
      return true;
    },
    [getNodeVisual, isRendererActive],
  );

  const frameNodes = useCallback(
    (targetNodeId?: string) => {
      const camera = cameraRef.current;
      const arcball = arcballRef.current;
      if (!camera || !arcball) return;

      const targetNode = targetNodeId ? nodeIndexRef.current.get(targetNodeId) : null;
      const target = targetNode
        ? {
            center: getNodePosition(targetNode),
            radius: Math.max(80, (targetNode.attributes.size || 4) * 26),
          }
        : getCameraTarget(nodesRef.current);

      const distance = Math.max(
        target.radius * (nodesRef.current.length > 5000 ? 1.22 : 1.55),
        140,
      );
      const destination = new THREE.Vector3(
        target.center.x + distance * 0.62,
        target.center.y + distance * 0.32,
        target.center.z + distance * 0.72,
      );

      camera.position.copy(destination);
      camera.near = Math.max(0.1, target.radius / 120);
      camera.far = Math.max(5000, target.radius * 18);
      camera.lookAt(target.center);
      camera.updateProjectionMatrix();

      arcball.target.copy(target.center);
      arcball.saveState();
      arcball.update();
      markSceneDirty({ cameraBillboards: true });
    },
    [markSceneDirty],
  );

  const stopLayout = useCallback(() => {
    simulationRef.current?.stop();
    layoutRunningRef.current = false;
    publishLayoutPositions('stop', { force: true });
    setIsLayoutRunning(false);
  }, [publishLayoutPositions]);

  const startLayout = useCallback(() => {
    if (nodesRef.current.length === 0 || !isRendererActive()) return;

    simulationRef.current?.stop();
    lastLayoutPositionPublishRef.current = null;

    const nodeCount = nodesRef.current.length;
    const linkDistance = nodeCount > 5000 ? 55 : nodeCount > 1500 ? 70 : 95;
    const chargeStrength = nodeCount > 5000 ? -46 : nodeCount > 1500 ? -68 : -96;

    const linkForce = forceLink<Graph3DNode, Graph3DLink>(linksRef.current)
      .id((node) => node.id)
      .distance((link) => {
        const relationType = link.attributes.relationType;
        if (relationType === 'CONTAINS' || relationType === 'DEFINES') return linkDistance * 0.72;
        if (relationType === 'CALLS') return linkDistance * 1.45;
        return linkDistance;
      })
      .strength((link) => {
        const relationType = link.attributes.relationType;
        if (relationType === 'CONTAINS') return 0.42;
        if (relationType === 'DEFINES') return 0.32;
        if (relationType === 'CALLS') return 0.08;
        return 0.16;
      });

    const simulation = forceSimulation<Graph3DNode>(nodesRef.current, 3)
      .force('link', linkForce)
      .force('charge', forceManyBody<Graph3DNode>().strength(chargeStrength).theta(0.9))
      .force(
        'collide',
        forceCollide<Graph3DNode>((node) => Math.max(4, (node.attributes.size || 4) * 2.3))
          .strength(0.28)
          .iterations(1),
      )
      .force('center', forceCenter<Graph3DNode>(0, 0, 0))
      .force('x', forceX<Graph3DNode>(0).strength(0.012))
      .force('y', forceY<Graph3DNode>(0).strength(0.012))
      .force('z', forceZ<Graph3DNode>(0).strength(0.012))
      .alpha(1)
      .alphaMin(0.001)
      .alphaDecay(getLayoutAlphaDecay(nodeCount))
      .velocityDecay(0.32)
      .on('end', () => {
        layoutRunningRef.current = false;
        publishLayoutPositions('end', { force: true });
        setIsLayoutRunning(false);
      });

    simulationRef.current = simulation;
    layoutRunningRef.current = true;
    publishLayoutPositions('start', { force: true });
    setIsLayoutRunning(true);
  }, [isRendererActive, publishLayoutPositions]);

  const disposeSceneObjects = useCallback(() => {
    const scene = sceneRef.current;
    colorComponentsCacheRef.current.clear();

    if (nodeMeshRef.current) {
      scene?.remove(nodeMeshRef.current);
      nodeMeshRef.current.geometry.dispose();
      disposeMaterial(nodeMeshRef.current.material);
      nodeMeshRef.current = null;
    }

    if (haloMeshRef.current) {
      scene?.remove(haloMeshRef.current);
      haloMeshRef.current.geometry.dispose();
      disposeMaterial(haloMeshRef.current.material);
      haloMeshRef.current = null;
    }

    if (shellMeshRef.current) {
      scene?.remove(shellMeshRef.current);
      shellMeshRef.current.geometry.dispose();
      disposeMaterial(shellMeshRef.current.material);
      shellMeshRef.current = null;
    }

    if (sparkPointsRef.current) {
      scene?.remove(sparkPointsRef.current);
      sparkPointsRef.current.geometry.dispose();
      disposeMaterial(sparkPointsRef.current.material);
      sparkPointsRef.current = null;
      sparkPositionsRef.current = null;
      sparkColorsRef.current = null;
      nodeVisualsRef.current = [];
    }

    if (edgeLinesRef.current) {
      scene?.remove(edgeLinesRef.current);
      edgeLinesRef.current.geometry.dispose();
      disposeMaterial(edgeLinesRef.current.material);
      edgeLinesRef.current = null;
      edgePositionsRef.current = null;
      edgeColorsRef.current = null;
      edgeRenderEntriesRef.current = [];
    }
  }, []);

  const setGraph = useCallback(
    (
      graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
      options: ThreeSetGraphOptions = {},
    ) => {
      const scene = sceneRef.current;
      if (!scene || !isRendererActive()) return;

      const shouldRunLayout = options.runLayout ?? true;
      const shouldResetCamera = options.resetCamera ?? true;
      const shouldClearSelection = options.clearSelection ?? false;
      const shouldPreservePositions = options.preservePositions ?? false;
      const previousPositions = new Map<string, { x?: number; y?: number; z?: number }>();

      if (shouldPreservePositions) {
        nodesRef.current.forEach((node) => {
          previousPositions.set(node.id, { x: node.x, y: node.y, z: node.z });
        });
      }

      stopLayout();
      disposeSceneObjects();
      graphRef.current = graph;
      if (shouldClearSelection) {
        setSelectedNode(null);
      }

      const nodeCount = Math.max(1, graph.order);
      const zSpread = Math.sqrt(nodeCount) * 48;
      const nodes: Graph3DNode[] = [];
      const nodeIndex = new Map<string, Graph3DNode>();

      graph.forEachNode((nodeId, attributes) => {
        const communityOffset =
          attributes.community === undefined
            ? 0
            : ((attributes.community % 9) - 4) * zSpread * 0.055;
        const previousPosition = previousPositions.get(nodeId);
        const node: Graph3DNode = {
          id: nodeId,
          attributes,
          x: previousPosition?.x ?? attributes.x,
          y: previousPosition?.y ?? attributes.y,
          z:
            previousPosition?.z ??
            attributes.z ??
            (hashToUnit(nodeId) - 0.5) * zSpread + communityOffset,
          vx: 0,
          vy: 0,
          vz: 0,
        };
        nodes.push(node);
        nodeIndex.set(nodeId, node);
      });

      const links: Graph3DLink[] = [];
      graph.forEachEdge((edgeId, attributes, sourceId, targetId) => {
        if (!nodeIndex.has(sourceId) || !nodeIndex.has(targetId)) return;
        const curveVector = new THREE.Vector3(
          hashToUnit(edgeId) - 0.5,
          hashToUnit(`${edgeId}:bend-y`) - 0.5,
          hashToUnit(`${edgeId}:bend-z`) - 0.5,
        );
        if (curveVector.lengthSq() < 0.0001) curveVector.set(0.35, 0.65, 0.2);
        links.push({
          id: edgeId,
          source: sourceId,
          target: targetId,
          sourceId,
          targetId,
          attributes,
          curveVector,
          curveMultiplier: getRelationCurveMultiplier(attributes.relationType),
        });
      });

      nodesRef.current = nodes;
      nodeIndexRef.current = nodeIndex;
      linksRef.current = links;
      edgeRenderEntriesRef.current = links.map((link, index) => {
        const source = nodeIndex.get(link.sourceId);
        const target = nodeIndex.get(link.targetId);
        if (!source || !target) {
          throw new Error(`Three graph edge ${link.id} references a missing node`);
        }
        const base = index * EDGE_CURVE_SEGMENTS * 6;
        return {
          link,
          source,
          target,
          base,
          span: EDGE_CURVE_SEGMENTS * 6,
          curveVectorX: link.curveVector.x,
          curveVectorY: link.curveVector.y,
          curveVectorZ: link.curveVector.z,
          curveMultiplier: link.curveMultiplier,
        };
      });
      colorComponentsCacheRef.current.clear();
      recordGraphPerf(optionsRef.current.perfObserver, GRAPH_PERF_METRICS.threeSceneUpdate, {
        label: 'setGraph:edge-topology',
        count: links.length,
      });

      const nodeSegments = getNodeGeometrySegments(nodes.length);
      const nodeGeometry = new THREE.CircleGeometry(1, nodeSegments);
      const haloGeometry = new THREE.CircleGeometry(1, Math.max(20, nodeSegments * 2));
      const shellGeometry = new THREE.RingGeometry(0.78, 1, Math.max(28, nodeSegments * 3));
      const nodeTexture = createRadialTexture([
        [0, '#ffffff'],
        [0.5, '#ffffff'],
        [0.78, '#d7f7ff'],
        [1, '#151827'],
      ]);
      const haloTexture = createRadialTexture([
        [0, '#ffffff'],
        [0.3, '#9be7ff'],
        [0.72, '#172033'],
        [1, '#000000'],
      ]);
      const sparkTexture = createRadialTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.5, 'rgba(255,255,255,0.96)'],
        [0.82, 'rgba(255,255,255,0.36)'],
        [1, 'rgba(255,255,255,0)'],
      ]);
      const haloMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        alphaMap: haloTexture,
        vertexColors: true,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const haloMesh = new THREE.InstancedMesh(haloGeometry, haloMaterial, nodes.length);
      haloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      haloMesh.frustumCulled = false;
      haloMesh.renderOrder = 1;
      scene.add(haloMesh);
      haloMeshRef.current = haloMesh;

      const shellMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        vertexColors: true,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const shellMesh = new THREE.InstancedMesh(shellGeometry, shellMaterial, nodes.length);
      shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      shellMesh.frustumCulled = false;
      shellMesh.renderOrder = 3;
      scene.add(shellMesh);
      shellMeshRef.current = shellMesh;

      const nodeMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        alphaMap: nodeTexture,
        vertexColors: true,
        transparent: true,
        opacity: 0.98,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const nodeMesh = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, nodes.length);
      nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      nodeMesh.frustumCulled = false;
      nodeMesh.renderOrder = 2;
      nodeMesh.userData.kind = 'graph-nodes';
      scene.add(nodeMesh);
      nodeMeshRef.current = nodeMesh;

      const sparkPositions = new Float32Array(Math.max(1, nodes.length * 3));
      const sparkColors = new Float32Array(Math.max(1, nodes.length * 3));
      const sparkGeometry = new THREE.BufferGeometry();
      sparkGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(sparkPositions, 3).setUsage(THREE.DynamicDrawUsage),
      );
      sparkGeometry.setAttribute(
        'color',
        new THREE.BufferAttribute(sparkColors, 3).setUsage(THREE.DynamicDrawUsage),
      );
      const sparkMaterial = new THREE.PointsMaterial({
        size: nodes.length > 5000 ? 5.4 : nodes.length > 1500 ? 6.6 : 8.2,
        sizeAttenuation: false,
        map: sparkTexture,
        vertexColors: true,
        transparent: true,
        opacity: 1,
        alphaTest: 0.02,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const sparkPoints = new THREE.Points(sparkGeometry, sparkMaterial);
      sparkPoints.frustumCulled = false;
      sparkPoints.renderOrder = 4;
      scene.add(sparkPoints);
      sparkPointsRef.current = sparkPoints;
      sparkPositionsRef.current = sparkPositions;
      sparkColorsRef.current = sparkColors;

      const edgeVertexCount = links.length * EDGE_CURVE_SEGMENTS * 2;
      const edgePositions = new Float32Array(Math.max(1, edgeVertexCount * 3));
      const edgeColors = new Float32Array(Math.max(1, edgeVertexCount * 3));
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(edgePositions, 3).setUsage(THREE.DynamicDrawUsage),
      );
      edgeGeometry.setAttribute(
        'color',
        new THREE.BufferAttribute(edgeColors, 3).setUsage(THREE.DynamicDrawUsage),
      );
      edgeGeometry.setDrawRange(0, edgeVertexCount);
      edgeGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000000);

      const edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.66,
        blending: THREE.AdditiveBlending,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      edgeLines.frustumCulled = false;
      scene.add(edgeLines);
      edgeLinesRef.current = edgeLines;
      edgePositionsRef.current = edgePositions;
      edgeColorsRef.current = edgeColors;

      markSceneFullyDirty();
      updateSceneObjects('setGraph');
      if (shouldResetCamera) {
        frameNodes();
      }
      if (shouldRunLayout) {
        startLayout();
      }
    },
    [
      disposeSceneObjects,
      frameNodes,
      isRendererActive,
      markSceneFullyDirty,
      setSelectedNode,
      startLayout,
      stopLayout,
      updateSceneObjects,
    ],
  );

  const setCameraMode = useCallback(
    (mode: ThreeGraphCameraMode) => {
      const arcball = arcballRef.current;
      const pointerLock = pointerLockRef.current;

      cameraModeRef.current = mode;
      setCameraModeState(mode);

      if (mode === 'firstPerson') {
        if (arcball) arcball.enabled = false;
        pointerLock?.lock();
      } else {
        pointerLock?.unlock();
        if (arcball) {
          arcball.enabled = true;
          arcball.update();
        }
      }
      markSceneDirty({ cameraBillboards: true });
    },
    [markSceneDirty],
  );

  const focusNode = useCallback(
    (nodeId: string) => {
      if (!nodeIndexRef.current.has(nodeId) || !isRendererActive()) return;
      setSelectedNode(nodeId);
      frameNodes(nodeId);
    },
    [frameNodes, isRendererActive, setSelectedNode],
  );

  const zoomToward = useCallback(
    (amount: number) => {
      const camera = cameraRef.current;
      const arcball = arcballRef.current;
      if (!camera || !arcball) return;

      const target = arcball.target;
      const direction = target.clone().sub(camera.position);
      camera.position.add(direction.multiplyScalar(amount));
      camera.lookAt(target);
      arcball.update();
      markSceneDirty({ cameraBillboards: true });
    },
    [markSceneDirty],
  );

  const zoomIn = useCallback(() => zoomToward(0.18), [zoomToward]);
  const zoomOut = useCallback(() => zoomToward(-0.22), [zoomToward]);

  const resetZoom = useCallback(() => {
    frameNodes();
    setSelectedNode(null);
  }, [frameNodes, setSelectedNode]);

  const refreshHighlights = useCallback(() => {
    markGraphVisualsDirty(true);
    if (isRendererActive()) {
      updateSceneObjects('refreshHighlights');
    }
  }, [isRendererActive, markGraphVisualsDirty, updateSceneObjects]);

  useEffect(() => {
    highlightedRef.current = options.highlightedNodeIds || new Set();
    blastRadiusRef.current = options.blastRadiusNodeIds || new Set();
    animatedNodesRef.current = options.animatedNodes || new Map();
    visibleEdgeTypeSetRef.current = options.visibleEdgeTypes
      ? new Set(options.visibleEdgeTypes)
      : null;
    markGraphVisualsDirty(true);
    if (isRendererActive()) {
      updateSceneObjects('visual-options');
    }
  }, [
    options.highlightedNodeIds,
    options.blastRadiusNodeIds,
    options.animatedNodes,
    options.visibleEdgeTypes,
    options.isActive,
    isRendererActive,
    markGraphVisualsDirty,
    updateSceneObjects,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);
    scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.00028);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 12000);
    camera.position.set(650, 420, 900);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    const readCappedPixelRatio = (cap: number) => Math.min(window.devicePixelRatio || 1, cap);
    let activePixelRatio = readCappedPixelRatio(MAX_DEVICE_PIXEL_RATIO);
    let usingInteractionPixelRatio = false;
    let interactionDprRestoreTimeout: number | null = null;
    renderer.setPixelRatio(activePixelRatio);
    renderer.setClearColor(BACKGROUND_COLOR, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.dataset.testid = 'three-graph-canvas';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.width = '100%';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const applyPixelRatio = (cap: number, label: string) => {
      const nextPixelRatio = readCappedPixelRatio(cap);
      if (Math.abs(nextPixelRatio - activePixelRatio) < 0.01) return;

      activePixelRatio = nextPixelRatio;
      renderer.setPixelRatio(nextPixelRatio);
      recordGraphPerf(optionsRef.current.perfObserver, GRAPH_PERF_METRICS.threeDprChange, {
        label: `${label}:${nextPixelRatio.toFixed(2)}`,
      });
    };

    const restoreFullPixelRatio = (label = 'idle') => {
      usingInteractionPixelRatio = false;
      if (interactionDprRestoreTimeout !== null) {
        window.clearTimeout(interactionDprRestoreTimeout);
        interactionDprRestoreTimeout = null;
      }
      applyPixelRatio(MAX_DEVICE_PIXEL_RATIO, label);
    };

    const requestInteractionPixelRatio = (label: string) => {
      usingInteractionPixelRatio = true;
      applyPixelRatio(INTERACTION_DEVICE_PIXEL_RATIO_CAP, label);

      if (interactionDprRestoreTimeout !== null) {
        window.clearTimeout(interactionDprRestoreTimeout);
      }
      interactionDprRestoreTimeout = window.setTimeout(() => {
        interactionDprRestoreTimeout = null;
        restoreFullPixelRatio('idle');
      }, INTERACTION_DPR_RESTORE_MS);
    };

    scene.add(new THREE.HemisphereLight('#e0f2fe', '#111827', 1.35));
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.8);
    keyLight.position.set(600, 700, 400);
    scene.add(keyLight);

    const arcball = new ArcballControls(camera, renderer.domElement, scene) as ArcballWithTarget;
    arcball.setGizmosVisible(false);
    arcball.enableAnimations = true;
    arcball.dampingFactor = 18;
    arcball.rotateSpeed = 1.15;
    arcball.cursorZoom = true;
    arcball.target.set(0, 0, 0);
    arcball.saveState();
    arcballRef.current = arcball;

    const pointerLock = new PointerLockControls(camera, renderer.domElement);
    pointerLock.pointerSpeed = 0.75;
    pointerLock.addEventListener('unlock', () => {
      if (cameraModeRef.current === 'firstPerson') {
        cameraModeRef.current = 'arcball';
        setCameraModeState('arcball');
        arcball.enabled = true;
      }
    });
    pointerLockRef.current = pointerLock;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const lastDprCameraPosition = camera.position.clone();
    const lastDprCameraQuaternion = camera.quaternion.clone();
    let hoverPickFrame: number | null = null;
    let pendingHoverPick: HoverPickRequest | null = null;
    let lastHoverPickClientX = Number.NaN;
    let lastHoverPickClientY = Number.NaN;
    let lastHoverPickTime = 0;
    let pointerIsDown = false;
    let pointerIsDragging = false;
    let pointerDownClientX = 0;
    let pointerDownClientY = 0;
    let cameraMovingUntil = 0;

    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      applyPixelRatio(
        usingInteractionPixelRatio ? INTERACTION_DEVICE_PIXEL_RATIO_CAP : MAX_DEVICE_PIXEL_RATIO,
        usingInteractionPixelRatio ? 'resize:interaction' : 'resize:full',
      );
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      arcball.update();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const recordHoverPickGate = (label: string) => {
      recordGraphPerf(optionsRef.current.perfObserver, GRAPH_PERF_METRICS.threePointerPick, {
        label: `hover:${label}`,
      });
    };

    const getPointerCursor = (nodeId: string | null): string =>
      nodeId ? 'pointer' : cameraModeRef.current === 'arcball' ? 'grab' : 'crosshair';

    const cancelPendingHoverPick = () => {
      pendingHoverPick = null;
      if (hoverPickFrame !== null) {
        cancelAnimationFrame(hoverPickFrame);
        hoverPickFrame = null;
      }
    };

    const applyHoveredNode = (nodeId: string | null, label: string) => {
      if (hoveredNodeRef.current !== nodeId) {
        hoveredNodeRef.current = nodeId;
        optionsRef.current.onNodeHover?.(nodeId);
        markSceneDirty({ nodeVisuals: true });
        updateSceneObjects(label);
      }
      container.style.cursor = getPointerCursor(nodeId);
    };

    const pickNode = (clientX: number, clientY: number, label: string): string | null => {
      const mesh = nodeMeshRef.current;
      if (
        !mesh ||
        !isActiveRef.current ||
        pointerLock.isLocked ||
        rendererRef.current !== renderer ||
        !renderer.domElement.isConnected
      ) {
        return null;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const finishPointerPick = startGraphPerfMeasure(
        optionsRef.current.perfObserver,
        GRAPH_PERF_METRICS.threePointerPick,
        { label },
      );

      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const intersections = raycaster.intersectObject(mesh, false);
      for (const intersection of intersections) {
        if (intersection.instanceId === undefined) continue;
        const node = nodesRef.current[intersection.instanceId];
        if (node && !node.attributes.hidden) {
          finishPointerPick();
          return node.id;
        }
      }

      finishPointerPick();
      return null;
    };

    const getHoverPickSkipReason = (request: HoverPickRequest, time: number): string | null => {
      if (!isActiveRef.current) return 'skipped:inactive';
      if (rendererRef.current !== renderer || !renderer.domElement.isConnected) {
        return 'skipped:inactive';
      }
      if (!nodeMeshRef.current) return 'skipped:no-mesh';
      if (pointerLock.isLocked) return 'skipped:pointer-lock';
      if (pointerIsDragging) return 'skipped:dragging';
      if (time < cameraMovingUntil) return 'skipped:camera-moving';

      if (Number.isFinite(lastHoverPickClientX) && Number.isFinite(lastHoverPickClientY)) {
        const deltaX = request.clientX - lastHoverPickClientX;
        const deltaY = request.clientY - lastHoverPickClientY;
        if (
          deltaX * deltaX + deltaY * deltaY <
          HOVER_POINTER_MOVE_THRESHOLD_PX * HOVER_POINTER_MOVE_THRESHOLD_PX
        ) {
          return 'skipped:stationary';
        }
      }

      const hoverCadenceMs = getHoverPickCadenceMs(nodesRef.current.length);
      if (
        hoverCadenceMs > 0 &&
        lastHoverPickTime > 0 &&
        time - lastHoverPickTime < hoverCadenceMs
      ) {
        return 'throttled:cadence';
      }

      return null;
    };

    const flushHoverPick = (time: number) => {
      hoverPickFrame = null;
      const request = pendingHoverPick;
      if (!request) return;

      const skipReason = getHoverPickSkipReason(request, time);
      if (skipReason) {
        recordHoverPickGate(skipReason);
        if (skipReason === 'throttled:cadence' || skipReason === 'skipped:camera-moving') {
          hoverPickFrame = requestAnimationFrame(flushHoverPick);
        } else {
          pendingHoverPick = null;
        }
        return;
      }

      pendingHoverPick = null;
      lastHoverPickClientX = request.clientX;
      lastHoverPickClientY = request.clientY;
      lastHoverPickTime = time;
      applyHoveredNode(
        pickNode(request.clientX, request.clientY, 'pointermove:hover'),
        'pointer-hover',
      );
    };

    const scheduleHoverPick = (event: PointerEvent) => {
      pendingHoverPick = { clientX: event.clientX, clientY: event.clientY };
      if (hoverPickFrame !== null) {
        recordHoverPickGate('throttled:frame');
        return;
      }
      hoverPickFrame = requestAnimationFrame(flushHoverPick);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!isActiveRef.current) return;

      if (pointerIsDown) {
        const deltaX = event.clientX - pointerDownClientX;
        const deltaY = event.clientY - pointerDownClientY;
        if (
          deltaX * deltaX + deltaY * deltaY >=
          HOVER_DRAG_THRESHOLD_PX * HOVER_DRAG_THRESHOLD_PX
        ) {
          pointerIsDragging = true;
          requestInteractionPixelRatio('pointer-drag');
        }
      }

      if (pointerIsDragging) {
        cancelPendingHoverPick();
        recordHoverPickGate('skipped:dragging');
        container.style.cursor = cameraModeRef.current === 'arcball' ? 'grabbing' : 'crosshair';
        return;
      }

      scheduleHoverPick(event);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!isActiveRef.current) return;

      pointerIsDown = true;
      pointerIsDragging = false;
      pointerDownClientX = event.clientX;
      pointerDownClientY = event.clientY;
      requestInteractionPixelRatio('pointerdown');
      if (cameraModeRef.current === 'arcball') {
        container.style.cursor = 'grabbing';
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!isActiveRef.current) return;

      pointerIsDown = false;
      pointerIsDragging = false;
      cancelPendingHoverPick();

      const nodeId = pickNode(event.clientX, event.clientY, 'pointerup');
      lastHoverPickClientX = event.clientX;
      lastHoverPickClientY = event.clientY;
      lastHoverPickTime = performance.now();
      if (nodeId) {
        setSelectedNode(nodeId);
        optionsRef.current.onNodeClick?.(nodeId);
      } else if (!pointerLock.isLocked) {
        setSelectedNode(null);
        hoveredNodeRef.current = null;
        optionsRef.current.onStageClick?.();
      }
      container.style.cursor = getPointerCursor(nodeId);
    };

    const handlePointerLeave = () => {
      if (!isActiveRef.current) return;

      pointerIsDown = false;
      pointerIsDragging = false;
      cancelPendingHoverPick();
      if (hoveredNodeRef.current !== null) {
        hoveredNodeRef.current = null;
        optionsRef.current.onNodeHover?.(null);
        markSceneDirty({ nodeVisuals: true });
        updateSceneObjects('pointer-leave');
      }
      container.style.cursor = cameraModeRef.current === 'arcball' ? 'grab' : 'crosshair';
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isActiveRef.current) return;
      keyStateRef.current.add(event.code);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isActiveRef.current) return;
      keyStateRef.current.delete(event.code);
    };

    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('pointerleave', handlePointerLeave);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    const animate = (time: number) => {
      if (!isActiveRef.current) {
        animationFrameRef.current = null;
        lastTimeRef.current = time;
        return;
      }

      animationFrameRef.current = requestAnimationFrame(animate);
      recordGraphPerf(optionsRef.current.perfObserver, GRAPH_PERF_METRICS.threeRafTick, {
        label: cameraModeRef.current,
      });
      const deltaSeconds = Math.min(0.05, (time - lastTimeRef.current) / 1000);
      lastTimeRef.current = time;

      if (cameraModeRef.current === 'firstPerson' && pointerLock.isLocked) {
        const keys = keyStateRef.current;
        const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 760 : 430;
        const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
        const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
        const lift =
          (keys.has('Space') ? 1 : 0) -
          (keys.has('ControlLeft') || keys.has('ControlRight') ? 1 : 0);

        if (forward !== 0) pointerLock.moveForward(forward * speed * deltaSeconds);
        if (strafe !== 0) pointerLock.moveRight(strafe * speed * deltaSeconds);
        if (lift !== 0) camera.position.y += lift * speed * deltaSeconds;
      } else {
        arcball.update();
      }

      const cameraMoved =
        lastDprCameraPosition.distanceToSquared(camera.position) >
          CAMERA_POSITION_MOVEMENT_THRESHOLD_SQ ||
        lastDprCameraQuaternion.angleTo(camera.quaternion) > CAMERA_ROTATION_MOVEMENT_THRESHOLD;
      if (cameraMoved) {
        lastDprCameraPosition.copy(camera.position);
        lastDprCameraQuaternion.copy(camera.quaternion);
        cameraMovingUntil = Math.max(cameraMovingUntil, time + HOVER_CAMERA_IDLE_MS);
        requestInteractionPixelRatio('camera');
      }

      if (layoutRunningRef.current) {
        publishLayoutPositions('frame', { nowMs: time });
      }
      updateSceneObjects('frame');
      if (renderPendingRef.current || cameraMoved || layoutRunningRef.current) {
        renderPendingRef.current = false;
        renderer.render(scene, camera);
      }
    };

    const pauseAnimationLoop = () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };

    const resumeAnimationLoop = () => {
      if (animationFrameRef.current !== null || !isActiveRef.current) return;
      lastTimeRef.current = performance.now();
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    pauseAnimationLoopRef.current = pauseAnimationLoop;
    resumeAnimationLoopRef.current = resumeAnimationLoop;
    resumeAnimationLoop();

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('pointerleave', handlePointerLeave);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      cancelPendingHoverPick();
      if (interactionDprRestoreTimeout !== null) {
        window.clearTimeout(interactionDprRestoreTimeout);
        interactionDprRestoreTimeout = null;
      }

      pauseAnimationLoop();

      simulationRef.current?.stop();
      simulationRef.current = null;
      layoutRunningRef.current = false;
      disposeSceneObjects();
      arcball.dispose();
      pointerLock.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      arcballRef.current = null;
      pointerLockRef.current = null;
      pauseAnimationLoopRef.current = null;
      resumeAnimationLoopRef.current = null;
    };
  }, [
    disposeSceneObjects,
    markSceneDirty,
    publishLayoutPositions,
    setSelectedNode,
    updateSceneObjects,
  ]);

  useEffect(() => {
    isActiveRef.current = options.isActive ?? true;

    if (!isRendererActive()) {
      pauseAnimationLoopRef.current?.();
      keyStateRef.current.clear();
      stopLayout();
      if (hoveredNodeRef.current !== null) {
        hoveredNodeRef.current = null;
        optionsRef.current.onNodeHover?.(null);
        markGraphVisualsDirty(false);
      }
      return;
    }

    markSceneFullyDirty();
    updateSceneObjects('resume');
    resumeAnimationLoopRef.current?.();
  }, [
    options.isActive,
    isRendererActive,
    markGraphVisualsDirty,
    markSceneFullyDirty,
    stopLayout,
    updateSceneObjects,
  ]);

  return {
    containerRef,
    setGraph,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    isLayoutRunning,
    startLayout,
    stopLayout,
    selectedNode,
    setSelectedNode,
    refreshHighlights,
    cameraMode,
    setCameraMode,
  };
};

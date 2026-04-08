<?php

namespace App\Http\Controllers;

use App\Http\Resources\ProjectAutoCollection;
use App\Http\Resources\ProjectMethodCollection;
use App\Http\Resources\ProjectCollection;
use App\Http\Resources\ProjectResource;
use App\Http\Resources\ProjectClosureCollection;
use App\Http\Resources\ProjectAssignedCollection;
use App\Http\Resources\ProjectDirectCollection;
use App\Http\Resources\ProjectIndexedCollection;
use App\Http\Resources\ProjectPreFilteredCollection;
use App\Http\Resources\ProjectTransformCollection;
use App\Http\Resources\ProjectTypedClosureCollection;
use App\Http\Resources\ProjectMappedCollection;
use App\Http\Resources\ProjectFilteredCollection;
use App\Http\Resources\ProjectThroughCollection;
use App\Http\Resources\ProjectWrappedCollection;

class PaginationController
{
    public function simple()
    {
        $page = request()->query('page');

        return ProjectResource::collection(
            Project::query()->simplePaginate(10, ['*'], 'page', $page)
        );
    }

    public function cursor()
    {
        $cursor = request()->query('cursor');

        return ProjectResource::collection(
            Project::query()->cursorPaginate(5, ['*'], 'cursor', $cursor)
        );
    }

    public function merged()
    {
        $page = request()->query('page');

        return ProjectResource::collection(
            Project::query()->paginate(20, ['*'], 'page', $page)
        )->additional([
            'meta' => [
                'source' => 'manual',
                'per_page' => 99,
            ],
            'links' => [
                'next' => 'https://example.test/projects?page=2',
                'docs' => 'https://example.test/docs/pagination',
            ],
        ]);
    }

    public function collectionClass()
    {
        $page = request()->query('page');

        return new ProjectCollection(
            Project::query()->paginate(12, ['*'], 'page', $page)
        );
    }

    public function collectionAuto()
    {
        $page = request()->query('page');

        return new ProjectAutoCollection(
            Project::query()->paginate(8, ['*'], 'page', $page)
        );
    }

    public function collectionMethod()
    {
        $page = request()->query('page');

        return new ProjectMethodCollection(
            Project::query()->paginate(6, ['*'], 'page', $page)
        );
    }

    public function collectionWrapped()
    {
        $page = request()->query('page');

        return new ProjectWrappedCollection(
            Project::query()->paginate(4, ['*'], 'page', $page)
        );
    }

    public function collectionMapped()
    {
        $page = request()->query('page');

        return new ProjectMappedCollection(
            Project::query()->paginate(3, ['*'], 'page', $page)
        );
    }

    public function collectionFiltered()
    {
        $page = request()->query('page');

        return new ProjectFilteredCollection(
            Project::query()->paginate(2, ['*'], 'page', $page)
        );
    }

    public function collectionThrough()
    {
        $page = request()->query('page');

        return new ProjectThroughCollection(
            Project::query()->paginate(7, ['*'], 'page', $page)
        );
    }

    public function collectionClosure()
    {
        $page = request()->query('page');

        return new ProjectClosureCollection(
            Project::query()->paginate(9, ['*'], 'page', $page)
        );
    }

    public function collectionTypedClosure()
    {
        $page = request()->query('page');

        return new ProjectTypedClosureCollection(
            Project::query()->paginate(11, ['*'], 'page', $page)
        );
    }

    public function collectionIndexed()
    {
        $page = request()->query('page');

        return new ProjectIndexedCollection(
            Project::query()->paginate(13, ['*'], 'page', $page)
        );
    }

    public function collectionDirect()
    {
        $page = request()->query('page');

        return new ProjectDirectCollection(
            Project::query()->paginate(14, ['*'], 'page', $page)
        );
    }

    public function collectionAssigned()
    {
        $page = request()->query('page');

        return new ProjectAssignedCollection(
            Project::query()->paginate(15, ['*'], 'page', $page)
        );
    }

    public function collectionPreFiltered()
    {
        $page = request()->query('page');

        return new ProjectPreFilteredCollection(
            Project::query()->paginate(16, ['*'], 'page', $page)
        );
    }

    public function collectionTransform()
    {
        $page = request()->query('page');

        return new ProjectTransformCollection(
            Project::query()->paginate(17, ['*'], 'page', $page)
        );
    }
}
